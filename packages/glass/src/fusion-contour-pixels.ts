// Pure group-contour raster work shared by the sync painter, the fused contour
// Worker and the bounded main-thread fallback. Nothing here touches the DOM, so
// the same bytes are produced on every path.
import { createForegroundRimRows, foregroundRimPixels } from "./foreground-rim.js";
import { fusionGeometry } from "./fusion-geometry.js";
import type { FusionShape } from "./fusion.js";
import { type GeometrySampler, type Shape } from "./optical-fields.js";

/** Device pixels per CSS pixel, matching the group contour canvas. */
const density = 2;
/** Outside bleed around the fusion plane, matching its CSS placement. */
const padding = 24;

export interface FusionContourInput {
  width: number;
  height: number;
  shapes: FusionShape[];
  spacing: number;
  grouped: boolean;
  /** The fitted contour material, including the blended press clarity. */
  shape: Shape;
}

export interface FusionContourImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export type FusionContourReply =
  | {
      id: number;
      data: ArrayBuffer;
      width: number;
      height: number;
      offsetX: number;
      offsetY: number;
      error?: never;
    }
  | { id: number; error: string };

function offset(rectangle?: { x: number; y: number }) {
  return {
    offsetX: (padding - 1 + (rectangle?.x ?? 0)) * density,
    offsetY: (padding - 1 + (rectangle?.y ?? 0)) * density,
  };
}

/** Rasterize the light group rim. A fused capsule reuses its fitted rim strips. */
export function fusionContourPixels(
  width: number,
  height: number,
  shape: Shape,
  sample: GeometrySampler,
): FusionContourImage {
  const rectangle = sample.roundedRect;
  const rim = rectangle
    ? foregroundRimPixels(rectangle.width, rectangle.height, rectangle.radius, shape)
    : foregroundRimPixels(width, height, 0, shape, sample);
  return { data: rim.data, width: rim.width, height: rim.height, ...offset(rectangle) };
}

/** Worker entry: rebuild the same sampler from the serialized fused geometry. */
export function fusionContourForInput(input: FusionContourInput): FusionContourImage {
  return fusionContourPixels(
    input.width,
    input.height,
    input.shape,
    fusionGeometry(input.shapes, input.spacing, input.grouped),
  );
}

export interface FusionContourJob {
  readonly image: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };
  readonly result: FusionContourImage;
  readonly done: boolean;
  advance(rows?: number): number;
}

/** Advance the same raster in bounded slices without changing its bytes. */
export function createFusionContourJob(input: FusionContourInput): FusionContourJob {
  const sample = fusionGeometry(input.shapes, input.spacing, input.grouped);
  const rectangle = sample.roundedRect;
  const rim = createForegroundRimRows(
    rectangle ? rectangle.width : input.width,
    rectangle ? rectangle.height : input.height,
    rectangle ? rectangle.radius : 0,
    input.shape,
    rectangle ? undefined : sample,
  );
  return {
    image: rim.image,
    result: { ...rim.image, ...offset(rectangle) },
    get done() {
      return rim.done;
    },
    advance(rows) {
      return rim.advance(rows);
    },
  };
}

/** Commit a completed contour without clearing the visible bitmap beforehand. */
export function paintFusionContourPixels(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  image: FusionContourImage,
) {
  const pixelWidth = Math.ceil((width + padding * 2) * density);
  const pixelHeight = Math.ceil((height + padding * 2) * density);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  // The optics geometry owns CSS size and may already be ahead of this bitmap.
  const context = canvas.getContext("2d")!;
  // Resizing above already wiped the bitmap; clear keeps an unchanged size
  // identical to the synchronous painter before it writes the new rim.
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.putImageData(
    new ImageData(image.data, image.width, image.height),
    image.offsetX,
    image.offsetY,
  );
}
