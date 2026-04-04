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
      required_modalities: [`${projectType.toLowerCase()}-${syntheticUser}-modality-1`],
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
          { id: 'proj-1', name: 'Current Project', project_type: 'PT1' },
          { id: 'proj-copy', name: 'Template Project', project_type: 'PT1' },
          { id: 'proj-cross-type', name: 'Cross-Type Project', project_type: 'PT2' },
        ],
      });
    }

    if (url.includes('/configuration/clone') && options.method === 'POST') {
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

        expect(screen.getAllByRole('heading', { name: 'Image Modalities' }).length).toBeGreaterThan(0);
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

      test(`supports image modality add/edit/remove for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Image modality label 1')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: 'Add Modality' }));
        fireEvent.change(screen.getByLabelText(`Image modality label ${config.image_modalities.length + 1}`), {
          target: { value: `Synthetic ${projectType} ${syntheticUser}` },
        });
        fireEvent.change(screen.getByLabelText(`Image modality id ${config.image_modalities.length + 1}`), {
          target: { value: `${projectType.toLowerCase()}-${syntheticUser}-custom` },
        });
        fireEvent.click(screen.getByLabelText(`Image modality calibration required ${config.image_modalities.length + 1}`));
        fireEvent.click(screen.getByLabelText(`Image modality example uploaded ${config.image_modalities.length + 1}`));
        fireEvent.change(screen.getByLabelText('Part view required modalities 1'), {
          target: { value: `${projectType.toLowerCase()}-${syntheticUser}-custom` },
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith(
            '/api/projects/proj-1/configuration',
            expect.objectContaining({
              method: 'PUT',
              body: expect.stringContaining(`Synthetic ${projectType} ${syntheticUser}`),
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

      
      test(`blocks save and shows validation errors for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Accept hotkey')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Accept hotkey'), { target: { value: 'q' } });
        fireEvent.change(screen.getByLabelText('Reject hotkey'), { target: { value: 'q' } });
        fireEvent.change(screen.getByLabelText('Defect type color 1'), { target: { value: 'red' } });
        fireEvent.change(screen.getByLabelText('Part view required modalities 1'), {
          target: { value: 'nonexistent_modality' },
        });

        const putCallsBefore = global.fetch.mock.calls.filter(
          ([url, options = {}]) => url === '/api/projects/proj-1/configuration' && options.method === 'PUT',
        ).length;

        fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

        await waitFor(() => {
          expect(screen.getByText(/Hotkeys must be unique/)).toBeInTheDocument();
          expect(screen.getByText(/Defect type colors must be valid/)).toBeInTheDocument();
          expect(screen.getByText(/Part views can only require modalities/)).toBeInTheDocument();
        });

        const putCallsAfter = global.fetch.mock.calls.filter(
          ([url, options = {}]) => url === '/api/projects/proj-1/configuration' && options.method === 'PUT',
        ).length;
        expect(putCallsAfter).toBe(putCallsBefore);
      });
test(`supports part view add/edit/remove for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Part view label 1')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: 'Add Part View' }));
        fireEvent.change(screen.getByLabelText(`Part view label ${config.part_views.length + 1}`), {
          target: { value: `Expanded ${projectType} ${syntheticUser}` },
        });
        fireEvent.change(screen.getByLabelText(`Part view id ${config.part_views.length + 1}`), {
          target: { value: `${projectType.toLowerCase()}-${syntheticUser}-expanded-view` },
        });
        fireEvent.change(screen.getByLabelText(`Part view required modalities ${config.part_views.length + 1}`), {
          target: { value: `${projectType.toLowerCase()}-${syntheticUser}-modality-1` },
        });
        fireEvent.change(screen.getByLabelText(`Part view source ${config.part_views.length + 1}`), {
          target: { value: 'auto' },
        });

        fireEvent.click(screen.getByLabelText('Remove part view 1'));
        fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith(
            '/api/projects/proj-1/configuration',
            expect.objectContaining({
              method: 'PUT',
              body: expect.stringContaining(`Expanded ${projectType} ${syntheticUser}`),
            }),
          );
          expect(global.fetch).toHaveBeenCalledWith(
            '/api/projects/proj-1/configuration',
            expect.objectContaining({
              method: 'PUT',
              body: expect.stringContaining(`"required_modalities":["${projectType.toLowerCase()}-${syntheticUser}-modality-1"]`),
            }),
          );
        });
      });
    });
  });

  projectTypes.forEach((projectType) => {
    syntheticUsers.forEach((syntheticUser) => {
      test(`copies configuration via clone endpoint for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith(
            '/api/projects/proj-1/configuration/clone',
            expect.objectContaining({
              method: 'POST',
              body: JSON.stringify({ source_project_id: 'proj-copy' }),
            }),
          );
          expect(screen.getByText('Configuration copied from existing project.')).toBeInTheDocument();
        });
      });

      test(`filters copy source projects by matching project type for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        expect(screen.getByText(/Only PT1 source projects are listed/)).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Template Project' })).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: 'Cross-Type Project' })).not.toBeInTheDocument();
      });
    });
  });
});
