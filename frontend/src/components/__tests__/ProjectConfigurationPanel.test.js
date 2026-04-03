import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProjectConfigurationPanel from '../ProjectConfigurationPanel';

const projectTypes = ['PT1', 'PT2', 'PT3'];
const syntheticUsers = ['basic', 'intermediate', 'advanced'];

function makeConfig(projectType, syntheticUser) {
  const complexity = syntheticUsers.indexOf(syntheticUser) + 1;
  return {
    image_modalities: Array.from({ length: complexity }, (_, index) => ({
      id: `${projectType.toLowerCase()}-${syntheticUser}-modality-${index + 1}`,
      label: `Modality ${index + 1}`,
      calibration_required: index > 0,
      example_image_uploaded: true,
    })),
    part_views: Array.from({ length: complexity + 1 }, (_, index) => ({
      id: `${projectType.toLowerCase()}-${syntheticUser}-view-${index + 1}`,
      label: `View ${index + 1}`,
      required_modalities: ['visual'],
      source: index % 2 === 0 ? 'manual' : 'auto',
    })),
    defect_types: Array.from({ length: complexity }, (_, index) => ({
      name: `Defect ${index + 1}`,
      color: '#ef4444',
      definition: `Definition ${index + 1}`,
    })),
    process_settings: {
      require_disposition_on_submit: true,
      require_measurement_for_critical: complexity > 1,
      require_second_reviewer_for_reject: complexity > 2,
      configurable_hotkeys: {
        accept_classification: complexity === 1 ? 'a' : complexity === 2 ? 's' : 'z',
        reject_classification: complexity === 1 ? 'r' : complexity === 2 ? 'd' : 'x',
        toggle_shortcut_help: complexity === 1 ? 'h' : complexity === 2 ? 'f' : 'c',
      },
    },
    display_settings: {
      default_colormap: complexity > 1 ? 'magma' : 'grayscale',
      anomaly_colormap: 'viridis',
      grayscale_base_image: true,
    },
  };
}

function mockFetch(config) {
  global.fetch = jest.fn((url, options = {}) => {
    if (url === '/api/projects') {
      return Promise.resolve({
        ok: true,
        json: async () => [
          { id: 'proj-1', name: 'Current Project' },
          { id: 'proj-copy', name: 'Template Project' },
        ],
      });
    }

    if (url.includes('/api/projects/proj-copy/configuration')) {
      return Promise.resolve({ ok: true, json: async () => ({ config: { ...config, defect_types: [] } }) });
    }

    if (url.includes('/configuration') && options.method === 'PUT') {
      return Promise.resolve({ ok: true, json: async () => ({ config }) });
    }

    if (url.includes('/configuration')) {
      return Promise.resolve({ ok: true, json: async () => ({ config }) });
    }

    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
}

describe('ProjectConfigurationPanel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  projectTypes.forEach((projectType) => {
    syntheticUsers.forEach((syntheticUser) => {
      test(`loads and saves configuration for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByTestId('project-configuration-summary')).toBeInTheDocument());

        expect(screen.getByRole('heading', { name: 'Image Modalities' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith(
            '/api/projects/proj-1/configuration',
            expect.objectContaining({ method: 'PUT' }),
          );
        });
      });

      test(`supports defect type add/edit/remove for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Defect type name 1')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: 'Add Defect Type' }));
        fireEvent.change(screen.getByLabelText(`Defect type name ${config.defect_types.length + 1}`), {
          target: { value: `Escalated ${projectType} ${syntheticUser}` },
        });
        fireEvent.change(screen.getByLabelText(`Defect type color ${config.defect_types.length + 1}`), {
          target: { value: '#22c55e' },
        });
        fireEvent.change(screen.getByLabelText(`Defect type definition ${config.defect_types.length + 1}`), {
          target: { value: 'Added during synthetic edit workflow' },
        });

        fireEvent.click(screen.getByLabelText('Remove defect type 1'));
        fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith(
            '/api/projects/proj-1/configuration',
            expect.objectContaining({
              method: 'PUT',
              body: expect.stringContaining(`Escalated ${projectType} ${syntheticUser}`),
            }),
          );
        });
      });

      test(`supports configurable hotkeys edits for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Accept hotkey')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Accept hotkey'), { target: { value: 'q' } });
        fireEvent.change(screen.getByLabelText('Reject hotkey'), { target: { value: 'w' } });
        fireEvent.change(screen.getByLabelText('Help hotkey'), { target: { value: 'e' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith(
            '/api/projects/proj-1/configuration',
            expect.objectContaining({
              method: 'PUT',
              body: expect.stringContaining('"accept_classification":"q"'),
            }),
          );
          expect(global.fetch).toHaveBeenCalledWith(
            '/api/projects/proj-1/configuration',
            expect.objectContaining({
              method: 'PUT',
              body: expect.stringContaining('"reject_classification":"w"'),
            }),
          );
          expect(global.fetch).toHaveBeenCalledWith(
            '/api/projects/proj-1/configuration',
            expect.objectContaining({
              method: 'PUT',
              body: expect.stringContaining('"toggle_shortcut_help":"e"'),
            }),
          );
        });
      });
    });
  });

  test('copies configuration from an existing project', async () => {
    const config = makeConfig('PT2', 'advanced');
    mockFetch(config);

    render(<ProjectConfigurationPanel projectId="proj-1" />);

    await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

    await waitFor(() => {
      expect(screen.getByText('Configuration copied from existing project.')).toBeInTheDocument();
    });
  });
});
