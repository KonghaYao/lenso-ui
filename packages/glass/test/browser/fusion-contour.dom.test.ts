import { expect, test } from "bun:test";
import {
  fusionContourForInput,
  type FusionContourImage,
  type FusionContourInput,
  type FusionContourReply,
} from "../../src/fusion-contour-pixels.js";
import { createFusionContourRenderer } from "../../src/fusion-contour-renderer.js";
import { foregroundRimPixels } from "../../src/foreground-rim.js";
import { fusionGeometry } from "../../src/fusion-geometry.js";
import type { Shape } from "../../src/refraction.js";

const light: Shape = {
  bezel: undefined,
  thickness: undefined,
  level: 1,
  zoom: 1,
  saturation: 1,
  dispersion: 0,
  faceSaturation: 1,
  lightIntensity: 0.25,
  lightAngle: 0,
  bevel: undefined,
  splay: undefined,
  appleMode: "light",
  materialTint: undefined,
  sourceBlur: 15.3,
  materialProfile: "small",
  materialSurface: "group",
  materialClarity: 0.4,
};

// Two fused capsules have no roundedRect shortcut, so the contour walks the
// shared distance field exactly like a real light group.
const input: FusionContourInput = {
  width: 84,
  height: 20,
  shapes: [
    { x: 0, y: 0, width: 40, height: 20, radius: 10 },
    { x: 44, y: 0, width: 40, height: 20, radius: 10 },
  ],
  spacing: 8,
  grouped: false,
  shape: light,
};

function expectedRim() {
  return foregroundRimPixels(
    input.width,
    input.height,
    0,
    input.shape,
    fusionGeometry(input.shapes, input.spacing, input.grouped),
  );
}

async function workerReply(workerInput: FusionContourInput) {
  const replies: FusionContourReply[] = [];
  const transfers: Transferable[][] = [];
  const scope = globalThis as unknown as {
    postMessage(reply: FusionContourReply, transfer?: Transferable[]): void;
    onmessage(event: { data: { id: number; input: FusionContourInput } }): unknown;
  };
  const previous = scope.postMessage;
  scope.postMessage = (reply, transfer) => {
    replies.push(reply);
    transfers.push(transfer ?? []);
  };
  await import("../../src/fusion-contour-worker.js");
  try {
    await scope.onmessage({ data: { id: 7, input: workerInput } });
  } finally {
    scope.postMessage = previous;
  }
  return { reply: replies[0]!, transfer: transfers[0]! };
}

test("the contour worker returns the synchronous rim bytes and padding offset", async () => {
  const { reply, transfer } = await workerReply(input);
  const expected = expectedRim();
  expect("error" in reply).toBe(false);
  if ("error" in reply) return;
  expect(reply.id).toBe(7);
  expect(new Uint8ClampedArray(reply.data)).toEqual(expected.data);
  expect([reply.width, reply.height]).toEqual([expected.width, expected.height]);
  // (24px padding - 1px hairline) * 2 device pixels.
  expect([reply.offsetX, reply.offsetY]).toEqual([46, 46]);
  expect(transfer).toEqual([reply.data]);
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: FusionContourReply }) => void;
  onerror?: (event: { message: string; preventDefault(): void }) => void;
  onmessageerror?: () => void;
  posted: { id: number; input: FusionContourInput }[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: { id: number; input: FusionContourInput }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(
    id: number,
    image: { data: Uint8ClampedArray<ArrayBuffer> } & Omit<FusionContourImage, "data">,
  ) {
    this.onmessage?.({
      data: {
        id,
        data: image.data.buffer,
        width: image.width,
        height: image.height,
        offsetX: image.offsetX,
        offsetY: image.offsetY,
      },
    });
  }
  fail(message: string) {
    this.onerror?.({ message, preventDefault() {} });
  }
}

function useWorker() {
  const previous = globalThis.Worker;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  return () => {
    globalThis.Worker = previous;
  };
}

test("one contour stays in flight and completed frames advance before the latest geometry", () => {
  const restore = useWorker();
  const renderer = createFusionContourRenderer();
  try {
    expect(renderer.backend).toBe("worker");
    const worker = FakeWorker.instances[0]!;
    const commits: FusionContourImage[] = [];
    renderer.request(input, (image) => commits.push(image));
    expect(worker.posted.length).toBe(1);
    for (let revision = 1; revision <= 4; revision++)
      renderer.request(
        { ...input, shapes: input.shapes.map((shape) => ({ ...shape, x: shape.x + revision })) },
        (image) => commits.push(image),
      );
    expect(worker.posted.length).toBe(1);

    // A completed frame must advance the contour even while newer geometry waits.
    worker.reply(worker.posted[0]!.id, {
      data: new Uint8ClampedArray([9, 9, 9, 9]),
      width: 1,
      height: 1,
      offsetX: 1,
      offsetY: 1,
    });
    expect(commits.length).toBe(1);
    expect(worker.posted.length).toBe(2);
    const latest = worker.posted[1]!;
    expect(latest.input.shapes[0]!.x).toBe(4);

    const result = fusionContourForInput(latest.input);
    worker.reply(latest.id, result);
    expect(commits.length).toBe(2);
    expect(commits[1]!.data).toEqual(result.data);
    expect([commits[1]!.offsetX, commits[1]!.offsetY]).toEqual([46, 46]);
    expect(worker.posted.length).toBe(2);
  } finally {
    renderer.destroy();
    restore();
  }
});

test("continuous geometry updates cannot starve worker commits and cancellation drops late replies", () => {
  const restore = useWorker();
  const renderer = createFusionContourRenderer();
  const worker = FakeWorker.instances[0]!;
  const image = fusionContourForInput(input);
  let commits = 0;
  try {
    renderer.request(input, () => commits++);
    for (let frame = 1; frame <= 120; frame++) {
      renderer.request({ ...input, width: input.width + frame }, () => commits++);
      const current = worker.posted.at(-1)!;
      worker.reply(current.id, image);
      expect(commits).toBe(frame);
      expect(worker.posted.length).toBe(frame + 1);
    }
    const canceled = worker.posted.at(-1)!;
    renderer.cancel();
    worker.reply(canceled.id, image);
    expect(commits).toBe(120);
    renderer.request(input, () => commits++);
    worker.reply(worker.posted.at(-1)!.id, image);
    expect(commits).toBe(121);
  } finally {
    renderer.destroy();
    restore();
  }
});

test("a throwing paint keeps the renderer usable for later frames", () => {
  const restore = useWorker();
  const report = console.error;
  console.error = () => {};
  const renderer = createFusionContourRenderer();
  try {
    const worker = FakeWorker.instances[0]!;
    renderer.request(input, () => {
      throw new Error("canvas gone");
    });
    const failed = worker.posted[0]!;
    expect(() => worker.reply(failed.id, fusionContourForInput(failed.input))).not.toThrow();
    const commits: FusionContourImage[] = [];
    renderer.request(input, (image) => commits.push(image));
    const latest = worker.posted[1]!;
    worker.reply(latest.id, fusionContourForInput(latest.input));
    expect(commits.length).toBe(1);
  } finally {
    console.error = report;
    renderer.destroy();
    restore();
  }
});

test("a late contour reply after teardown never paints or derives another request", () => {
  const restore = useWorker();
  const renderer = createFusionContourRenderer();
  // A neighboring plane owns the shared thread, so teardown cannot rely on
  // terminating the Worker to silence this plane's late reply.
  const neighbor = createFusionContourRenderer();
  try {
    const worker = FakeWorker.instances[0]!;
    const commits: FusionContourImage[] = [];
    renderer.request(input, (image) => commits.push(image));
    const pending = worker.posted[0]!;
    renderer.destroy();
    expect(worker.terminated).toBe(false);
    worker.reply(pending.id, fusionContourForInput(pending.input));
    expect(commits.length).toBe(0);
    expect(worker.posted.length).toBe(1);
    renderer.request(input, (image) => commits.push(image));
    expect(worker.posted.length).toBe(1);
    expect(commits.length).toBe(0);
    neighbor.destroy();
    expect(worker.terminated).toBe(true);
  } finally {
    renderer.destroy();
    neighbor.destroy();
    restore();
  }
});

test("the Worker-free fallback finishes in bounded row slices with identical bytes", () => {
  const previous = globalThis.Worker;
  globalThis.Worker = undefined as unknown as typeof Worker;
  const steps: (() => void)[] = [];
  const renderer = createFusionContourRenderer({
    budgetMs: 0,
    rowsPerSlice: 4,
    schedule: (callback) => steps.push(callback),
  });
  const commits: FusionContourImage[] = [];
  try {
    expect(renderer.backend).toBe("main");
    renderer.request(input, (image) => commits.push(image));
    expect(commits.length).toBe(0);
    expect(steps.length).toBe(1);
    let slices = 1;
    while (steps.length) {
      const step = steps.shift()!;
      slices++;
      step();
    }
    expect(commits.length).toBe(1);
    const expected = expectedRim();
    expect(commits[0]!.data).toEqual(expected.data);
    expect([commits[0]!.offsetX, commits[0]!.offsetY]).toEqual([46, 46]);
    // No slice rasterized more than 4 of the 44 rows.
    expect(slices).toBe(Math.ceil(expected.height / 4));
  } finally {
    renderer.destroy();
    globalThis.Worker = previous;
  }
});

test("the fallback presents completed frames before advancing to the latest geometry", () => {
  const previous = globalThis.Worker;
  globalThis.Worker = undefined as unknown as typeof Worker;
  const steps: (() => void)[] = [];
  const renderer = createFusionContourRenderer({
    budgetMs: 0,
    rowsPerSlice: 4,
    schedule: (callback) => steps.push(callback),
  });
  const commits: FusionContourImage[] = [];
  const latest = {
    ...input,
    shapes: input.shapes.map((shape) => ({ ...shape, x: shape.x + 6 })),
  };
  try {
    renderer.request(input, (image) => commits.push(image));
    renderer.request(latest, (image) => commits.push(image));
    // Both completed jobs must paint so a stream of updates cannot freeze the rim.
    while (steps.length) steps.shift()!();
    expect(commits.length).toBe(2);
    expect(commits[0]!.data).toEqual(fusionContourForInput(input).data);
    expect(commits[1]!.data).toEqual(fusionContourForInput(latest).data);
  } finally {
    renderer.destroy();
    globalThis.Worker = previous;
  }
});

test("continuous updates also advance the fallback before motion settles", () => {
  const previous = globalThis.Worker;
  globalThis.Worker = undefined as unknown as typeof Worker;
  const steps: (() => void)[] = [];
  const renderer = createFusionContourRenderer({
    budgetMs: 0,
    rowsPerSlice: 4,
    schedule: (callback) => steps.push(callback),
  });
  const committed: number[] = [];
  try {
    renderer.request(input, () => committed.push(0));
    for (let frame = 1; frame <= 120; frame++) {
      renderer.request({ ...input, width: input.width + frame }, () => committed.push(frame));
      steps.shift()!();
    }
    expect(committed.length).toBeGreaterThan(1);
    while (steps.length) steps.shift()!();
    expect(committed.at(-1)).toBe(120);
  } finally {
    renderer.destroy();
    globalThis.Worker = previous;
  }
});

test("a worker error keeps the plane alive on the bounded fallback", () => {
  const restore = useWorker();
  const steps: (() => void)[] = [];
  const renderer = createFusionContourRenderer({
    budgetMs: 0,
    rowsPerSlice: 8,
    schedule: (callback) => steps.push(callback),
  });
  const commits: FusionContourImage[] = [];
  try {
    renderer.request(input, (image) => commits.push(image));
    expect(renderer.backend).toBe("worker");
    FakeWorker.instances[0]!.fail("worker blocked");
    expect(renderer.backend).toBe("main");
    while (steps.length) steps.shift()!();
    expect(commits.length).toBe(1);
    expect(commits[0]!.data).toEqual(expectedRim().data);
  } finally {
    renderer.destroy();
    restore();
  }
});

test("a worker that cannot accept the request falls back instead of throwing", () => {
  const previous = globalThis.Worker;
  const steps: (() => void)[] = [];
  let started = 0;
  class ThrowingWorker extends FakeWorker {
    override postMessage() {
      started++;
      throw new Error("worker blocked");
    }
  }
  globalThis.Worker = ThrowingWorker as unknown as typeof Worker;
  const renderer = createFusionContourRenderer({
    budgetMs: 0,
    rowsPerSlice: 16,
    schedule: (callback) => steps.push(callback),
  });
  const commits: FusionContourImage[] = [];
  try {
    expect(() => renderer.request(input, (image) => commits.push(image))).not.toThrow();
    expect(started).toBe(1);
    expect(renderer.backend).toBe("main");
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    while (steps.length) steps.shift()!();
    expect(commits.length).toBe(1);
    expect(commits[0]!.data).toEqual(expectedRim().data);
  } finally {
    renderer.destroy();
    globalThis.Worker = previous;
  }
});
