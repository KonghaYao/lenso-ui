import {
  createFusionContourJob,
  type FusionContourImage,
  type FusionContourInput,
  type FusionContourReply,
} from "./fusion-contour-pixels.js";

type Work = { input: FusionContourInput; commit: (image: FusionContourImage) => void };
type Pending = { resolve: (image: FusionContourImage) => void; reject: (error: Error) => void };
type Plane = { work: Work; id?: number; job?: ReturnType<typeof createFusionContourJob> };

const requests = new Map<number, Pending>();
let worker: Worker | undefined;
let users = 0;
let nextRequest = 0;
let failed = false;

function fail(error: Error) {
  worker?.terminate();
  worker = undefined;
  failed = true;
  const pending = [...requests.values()];
  requests.clear();
  for (const entry of pending) entry.reject(error);
}

function acquire() {
  users++;
  if (worker || failed || typeof Worker === "undefined") return;
  try {
    worker = new Worker(new URL("./fusion-contour-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<FusionContourReply>) => {
      const entry = requests.get(data.id);
      if (!entry) return;
      requests.delete(data.id);
      if (data.error !== undefined) entry.reject(new Error(data.error));
      else
        entry.resolve({
          data: new Uint8ClampedArray(data.data),
          width: data.width,
          height: data.height,
          offsetX: data.offsetX,
          offsetY: data.offsetY,
        });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(new Error(event.message));
    };
    worker.onmessageerror = () => fail(new Error("Unable to receive the fusion contour"));
  } catch {
    failed = true;
  }
}

function scheduleFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback());
  else setTimeout(callback, 0);
}

// A paint failure must keep the preceding frame instead of unwinding the
// caller's animation loop or the shared worker's message handler.
function commit(work: Work, image: FusionContourImage) {
  try {
    work.commit(image);
  } catch (error) {
    console.error(error);
  }
}

export interface FusionContourRendererOptions {
  /** Milliseconds of fallback rasterization per scheduled slice. */
  budgetMs?: number;
  /** Hard row cap per fallback slice, independent of the time budget. */
  rowsPerSlice?: number;
  /** Test seam: schedule the next fallback slice. Defaults to an animation frame. */
  schedule?: (callback: () => void) => void;
}

/**
 * One dedicated contour thread shared by every fused plane. Each plane keeps at
 * most one request in flight and a single latest slot, so obsolete geometry is
 * replaced instead of queued. A Worker failure switches to a row-budgeted
 * main-thread job; neither path throws into the optics drain and hides the surface.
 */
export function createFusionContourRenderer(options: FusionContourRendererOptions = {}) {
  acquire();
  const budget = options.budgetMs ?? 4;
  // One row per call keeps a wide plane from overshooting the slice budget; the
  // loop below keeps advancing rows while the time budget remains.
  const rows = Math.max(1, Math.floor(options.rowsPerSlice ?? 1));
  const schedule = options.schedule ?? scheduleFrame;
  let stopped = false;
  let plane: Plane | undefined;
  let latest: Work | undefined;

  function step(ticket: Plane) {
    if (stopped || plane !== ticket || !ticket.job) return;
    const job = ticket.job;
    const started = performance.now();
    try {
      do {
        job.advance(rows);
      } while (!job.done && performance.now() - started < budget);
    } catch (error) {
      console.error(error);
      if (plane === ticket) plane = undefined;
      return;
    }
    if (!job.done) {
      schedule(() => step(ticket));
      return;
    }
    plane = undefined;
    // Newer geometry arrived while this slice ran; only the latest is committed,
    // and the replacement job starts on the next slice instead of extending this one.
    if (latest) {
      schedule(dispatch);
      return;
    }
    commit(ticket.work, job.result);
    dispatch();
  }

  function begin(work: Work) {
    if (stopped) return;
    let job: ReturnType<typeof createFusionContourJob>;
    try {
      job = createFusionContourJob(work.input);
    } catch (error) {
      // Keep the preceding frame instead of blanking the contour.
      console.error(error);
      return;
    }
    const ticket: Plane = { work, job };
    plane = ticket;
    step(ticket);
  }

  function dispatch() {
    if (stopped || plane || !latest) return;
    const work = latest;
    latest = undefined;
    if (worker) {
      const id = nextRequest++;
      const ticket: Plane = { work, id };
      plane = ticket;
      requests.set(id, {
        resolve: (image) => {
          if (stopped || plane !== ticket) return;
          plane = undefined;
          if (latest) {
            dispatch();
            return;
          }
          commit(work, image);
          dispatch();
        },
        reject: () => {
          if (stopped || plane !== ticket) return;
          plane = undefined;
          begin(work);
        },
      });
      try {
        worker.postMessage({ id, input: work.input });
      } catch {
        requests.delete(id);
        fail(new Error("Unable to prepare the fusion contour in a worker"));
        if (plane === ticket) plane = undefined;
        begin(work);
      }
      return;
    }
    begin(work);
  }

  return {
    get backend() {
      return worker ? "worker" : "main";
    },
    request(input: FusionContourInput, commit: (image: FusionContourImage) => void) {
      if (stopped) return;
      latest = { input, commit };
      dispatch();
    },
    /** Drop queued and in-flight work; late worker replies must not paint. */
    cancel() {
      latest = undefined;
      const ticket = plane;
      plane = undefined;
      if (ticket?.id !== undefined) requests.delete(ticket.id);
    },
    destroy() {
      if (stopped) return;
      stopped = true;
      latest = undefined;
      const ticket = plane;
      plane = undefined;
      if (ticket?.id !== undefined) requests.delete(ticket.id);
      if (--users === 0) {
        worker?.terminate();
        worker = undefined;
        failed = false;
        requests.clear();
      }
    },
  };
}
