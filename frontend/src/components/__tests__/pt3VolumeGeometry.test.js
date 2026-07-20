import { applyRescale, getPhysicalBounds, mapWindowLevel, opacityCorrection, physicalToVoxel, pointInsideCropBox, voxelToPhysical } from '../pt3VolumeGeometry';
import { CT_TRANSFER_PRESETS, generateTransferFunctionLut } from '../pt3TransferFunctions';

test('voxel to physical preserves anisotropic spacing and origin', () => {
  const metadata = { dimensions: [10, 20, 30], spacing: [0.5, 0.75, 2], origin: [10, 20, -5] };
  expect(voxelToPhysical([2, 4, 3], metadata)).toEqual([11, 23, 1]);
  expect(physicalToVoxel([11, 23, 1], metadata)).toEqual([2, 4, 3]);
});

test('voxel transform supports non-identity orthonormal direction', () => {
  const metadata = { spacing: [1, 2, 3], origin: [0, 0, 0], direction: [0, -1, 0, 1, 0, 0, 0, 0, 1] };
  const physical = voxelToPhysical([2, 3, 4], metadata);
  expect(physical).toEqual([-6, 2, 12]);
  expect(physicalToVoxel(physical, metadata).map((v) => Math.round(v))).toEqual([2, 3, 4]);
});

test('bounds, rescale, window level, opacity, and crop helpers are deterministic', () => {
  const metadata = { dimensions: [3, 4, 5], spacing: [2, 3, 4], rescaleSlope: 2, rescaleIntercept: -1024 };
  expect(getPhysicalBounds(metadata).size).toEqual([4, 9, 16]);
  expect(applyRescale(512, metadata)).toBe(0);
  expect(mapWindowLevel(40, 400, 40)).toBeCloseTo(0.5);
  expect(opacityCorrection(0.5, 2, 1)).toBeCloseTo(0.75);
  expect(pointInsideCropBox([1, 1, 1], { enabled: true, min: [0, 0, 0], max: [2, 2, 2] })).toBe(true);
  expect(pointInsideCropBox([3, 1, 1], { enabled: true, min: [0, 0, 0], max: [2, 2, 2] })).toBe(false);
});

test('transfer function LUT encodes CT presets with opacity', () => {
  const lut = generateTransferFunctionLut({ preset: CT_TRANSFER_PRESETS.bone, scalarRange: [-1024, 3071], opacityMultiplier: 1 });
  expect(lut).toHaveLength(1024);
  expect(lut[1023]).toBeGreaterThan(0);
});
