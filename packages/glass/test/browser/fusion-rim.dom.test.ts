import { expect, test } from "bun:test";
import { paintFusionContourPixels } from "../../src/fusion-contour-pixels.js";
import { paintFusionContour } from "../../src/fusion-contour.js";
import { fusionGeometry } from "../../src/fusion-geometry.js";
import { foregroundRimPixels } from "../../src/foreground-rim.js";
import type { Shape } from "../../src/refraction.js";

// Sampling the standalone helper alone cannot catch a shared contour replacing
// its fitted material with a flat stroke, or scanning a full group on every update.
test("light fusion paints the standalone rim at its offset without resampling a capsule", () => {
  const shape: Shape = {
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
  };
  const rectangle = { x: 20, y: 8, width: 220, height: 34, radius: 17 };
  const sample = fusionGeometry([rectangle], 0);
  const canvas = document.createElement("canvas");
  let painted: ImageData | undefined;
  let position: number[] = [];
  canvas.getContext = (() => ({
    setTransform() {},
    clearRect() {},
    putImageData(image: ImageData, x: number, y: number) {
      painted = image;
      position = [x, y];
    },
  })) as unknown as typeof canvas.getContext;
  const geometry = Object.assign(() => {
    throw new Error("A capsule must reuse its rim strips");
  }, sample);
  paintFusionContour(canvas, 280, 60, "", geometry, shape);
  const expected = foregroundRimPixels(rectangle.width, rectangle.height, rectangle.radius, shape);
  expect(painted?.data).toEqual(expected.data);
  expect(position).toEqual([86, 62]);
});

// Multiple fused members have no roundedRect shortcut, so the canvas must place
// the shared distance-field rim at the padding offset without a capsule crop.
test("light fusion paints the fused group field at its padded offset", () => {
  const shape: Shape = {
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
  };
  const shapes = [
    { x: 0, y: 0, width: 40, height: 20, radius: 10 },
    { x: 44, y: 0, width: 40, height: 20, radius: 10 },
  ];
  const sample = fusionGeometry(shapes, 8);
  const canvas = document.createElement("canvas");
  let painted: ImageData | undefined;
  let position: number[] = [];
  canvas.getContext = (() => ({
    setTransform() {},
    clearRect() {},
    putImageData(image: ImageData, x: number, y: number) {
      painted = image;
      position = [x, y];
    },
  })) as unknown as typeof canvas.getContext;
  paintFusionContour(canvas, 84, 20, "", sample, shape);
  const expected = foregroundRimPixels(84, 20, 0, shape, sample);
  expect(painted?.data).toEqual(expected.data);
  expect(position).toEqual([46, 46]);
});

// A completed asynchronous contour sizes and writes the visible bitmap in one
// commit; the preceding frame stays untouched until then.
test("a completed contour commit clears and writes the padded bitmap once", () => {
  const canvas = document.createElement("canvas");
  canvas.style.width = "200px";
  canvas.style.height = "100px";
  const calls: string[] = [];
  let painted: ImageData | undefined;
  let position: number[] = [];
  canvas.getContext = (() => ({
    setTransform(...args: number[]) {
      calls.push(`transform:${args.join(",")}`);
    },
    clearRect(...args: number[]) {
      calls.push(`clear:${args.join(",")}`);
    },
    putImageData(image: ImageData, x: number, y: number) {
      painted = image;
      position = [x, y];
      calls.push("put");
    },
  })) as unknown as typeof canvas.getContext;
  const image = {
    data: new Uint8ClampedArray([1, 2, 3, 4]),
    width: 1,
    height: 1,
    offsetX: 46,
    offsetY: 46,
  };
  paintFusionContourPixels(canvas, 84, 20, image);
  expect([canvas.width, canvas.height]).toEqual([264, 136]);
  // Geometry may have advanced while this bitmap was rendering.
  expect([canvas.style.width, canvas.style.height]).toEqual(["200px", "100px"]);
  expect(calls).toEqual(["transform:1,0,0,1,0,0", "clear:0,0,264,136", "put"]);
  expect(painted?.data).toEqual(image.data);
  expect(position).toEqual([46, 46]);
});
