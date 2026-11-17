import {
  fusionContourForInput,
  type FusionContourInput,
  type FusionContourReply,
} from "./fusion-contour-pixels.js";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ id: number; input: FusionContourInput }>) => void;
  postMessage: (reply: FusionContourReply, transfer?: Transferable[]) => void;
};

// A dedicated thread: contour rasterization never waits behind GPU optical
// fields, and a contour failure cannot terminate the field pipeline.
scope.onmessage = ({ data }: MessageEvent<{ id: number; input: FusionContourInput }>) => {
  try {
    const image = fusionContourForInput(data.input);
    const buffer = image.data.buffer as ArrayBuffer;
    scope.postMessage(
      {
        id: data.id,
        data: buffer,
        width: image.width,
        height: image.height,
        offsetX: image.offsetX,
        offsetY: image.offsetY,
      },
      [buffer],
    );
  } catch (error) {
    scope.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
