import { getMechanicalCropBox, getMechanicalVolumeMetadata, makeMechanicalFallbackSplats, countVisibleSplats } from '../pt3MechanicalVisualization';

describe('mechanical 3D visualization helpers', () => {
  test('derives industrial part metadata without medical defaults', () => {
    const metadata = getMechanicalVolumeMetadata({ id: 'gear-1', metadata: { volume_shape: { sagittal: 20, coronal: 10, axial: 5 } } });
    expect(metadata.dimensions).toEqual([20, 10, 5]);
    expect(metadata.spacing).toEqual([0.08, 0.08, 0.12]);
    expect(metadata.modality).toBe('industrial_ct');
    expect(metadata.sourceId).toBe('gear-1');
  });

  test('creates deterministic mechanical splat layers and crop counts', () => {
    const metadata = getMechanicalVolumeMetadata({ id: 'bracket-1', metadata: { volume_shape: { sagittal: 16, coronal: 16, axial: 8 } } });
    const splats = makeMechanicalFallbackSplats(metadata);
    expect(splats.positions).toHaveLength(720 * 3);
    expect(splats.layers.map((layer) => layer.id)).toEqual(['surface', 'core', 'defect-candidates']);
    const fullCount = countVisibleSplats(splats, getMechanicalCropBox(metadata, false));
    const croppedCount = countVisibleSplats(splats, getMechanicalCropBox(metadata, true));
    expect(fullCount).toBe(720);
    expect(croppedCount).toBeGreaterThan(0);
    expect(croppedCount).toBeLessThan(fullCount);
  });
});
