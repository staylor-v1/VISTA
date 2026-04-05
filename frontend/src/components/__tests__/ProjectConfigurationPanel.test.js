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

function mockFetch(config, projectType, mockOptions = {}) {
  const alternateProjectType = projectType === 'PT1' ? 'PT2' : 'PT1';
  global.fetch = jest.fn((url, requestOptions = {}) => {
    if (url === '/api/projects') {
      return Promise.resolve({
        ok: true,
        json: async () => [
          { id: 'proj-1', name: 'Current Project', project_type: projectType },
          { id: 'proj-copy', name: 'Template Project', project_type: projectType },
          { id: 'proj-copy-2', name: 'Template Project 2', project_type: projectType },
          { id: 'proj-cross-type', name: 'Cross-Type Project', project_type: alternateProjectType },
        ],
      });
    }

    if (url.includes('/configuration/clone') && requestOptions.method === 'POST') {
      if (mockOptions.cloneFailureDetail) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ detail: mockOptions.cloneFailureDetail }),
        });
      }
      if (mockOptions.cloneInvalidJson) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('invalid json');
          },
        });
      }
      if (mockOptions.delayedClone) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, json: async () => ({ config: { ...config, defect_types: [] } }) }), 25);
        });
      }
      if (mockOptions.cloneMissingConfig) {
        return Promise.resolve({ ok: true, json: async () => ({ copied: true }) });
      }
      if (mockOptions.cloneInvalidConfigShape) {
        return Promise.resolve({ ok: true, json: async () => ({ config: {} }) });
      }
      if (mockOptions.cloneInvalidConfigEntries) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            config: {
              ...config,
              image_modalities: [null],
              part_views: [{ id: 'pv-1', label: 'View 1', required_modalities: 'not-an-array' }],
              defect_types: ['not-an-object'],
            },
          }),
        });
      }
      if (mockOptions.cloneInvalidConfigScalarFields) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            config: {
              ...config,
              image_modalities: [{ id: 123, label: 'Modality 1' }],
              part_views: [{ id: 'pv-1', label: 42, required_modalities: [9] }],
              defect_types: [{ name: null, color: '#ef4444' }],
            },
          }),
        });
      }
      if (mockOptions.cloneInvalidConfigSettingsFields) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            config: {
              ...config,
              process_settings: {
                require_disposition_on_submit: 'yes',
                require_measurement_for_critical: true,
                require_second_reviewer_for_reject: false,
                configurable_hotkeys: {
                  accept_classification: 'a',
                  reject_classification: 9,
                  toggle_shortcut_help: 'h',
                },
              },
              display_settings: {
                default_colormap: 'grayscale',
                anomaly_colormap: 'viridis',
                grayscale_base_image: 'true',
              },
            },
          }),
        });
      }
      if (mockOptions.cloneInvalidConfigDomainFields) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            config: {
              ...config,
              part_views: [{ id: 'pv-1', label: 'View 1', required_modalities: [config.image_modalities[0]?.id || 'm1'], source: 'api' }],
              display_settings: {
                ...config.display_settings,
                default_colormap: 'plasma',
              },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ config: { ...config, defect_types: [] } }) });
    }

    if (url.includes('/configuration') && requestOptions.method === 'PUT') {
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
        mockFetch(config, projectType);

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
        mockFetch(config, projectType);

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
        mockFetch(config, projectType);

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
        mockFetch(config, projectType);

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
        mockFetch(config, projectType);

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
        mockFetch(config, projectType);

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
        mockFetch(config, projectType);

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
          expect(screen.getByText('Configuration copied from Template Project.')).toBeInTheDocument();
        });
      });

      test(`resets clone source selection after successful copy for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText('Configuration copied from Template Project.')).toBeInTheDocument();
        });

        expect(screen.getByLabelText('Source project')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Copy from Project' })).toBeDisabled();
      });


      test(`surfaces clone API detail errors for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        const cloneFailureDetail = `Source project is not compatible with ${projectType}`;
        mockFetch(config, projectType, { cloneFailureDetail });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText(cloneFailureDetail)).toBeInTheDocument();
        });
        expect(screen.queryByText('Configuration copied from Template Project.')).not.toBeInTheDocument();
      });

      test(`falls back to status error when clone API response is non-JSON for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType, { cloneInvalidJson: true });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText('Failed to copy project configuration (502)')).toBeInTheDocument();
        });
      });

      test(`rejects clone success payloads that omit config for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType, { cloneMissingConfig: true });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText('Failed to copy project configuration (missing config payload)')).toBeInTheDocument();
        });
        expect(screen.queryByText('Configuration copied from Template Project.')).not.toBeInTheDocument();
      });

      test(`rejects clone success payloads with invalid config shape for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType, { cloneInvalidConfigShape: true });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText('Failed to copy project configuration (invalid config payload shape)')).toBeInTheDocument();
        });
        expect(screen.queryByText('Configuration copied from Template Project.')).not.toBeInTheDocument();
      });

      test(`rejects clone success payloads with invalid config entries for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType, { cloneInvalidConfigEntries: true });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText('Failed to copy project configuration (invalid config payload entries)')).toBeInTheDocument();
        });
        expect(screen.queryByText('Configuration copied from Template Project.')).not.toBeInTheDocument();
      });

      test(`rejects clone success payloads with invalid config scalar fields for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType, { cloneInvalidConfigScalarFields: true });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText('Failed to copy project configuration (invalid config scalar fields)')).toBeInTheDocument();
        });
        expect(screen.queryByText('Configuration copied from Template Project.')).not.toBeInTheDocument();
      });

      test(`rejects clone success payloads with invalid config settings fields for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType, { cloneInvalidConfigSettingsFields: true });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText('Failed to copy project configuration (invalid config settings fields)')).toBeInTheDocument();
        });
        expect(screen.queryByText('Configuration copied from Template Project.')).not.toBeInTheDocument();
      });

      test(`rejects clone success payloads with invalid config domain fields for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType, { cloneInvalidConfigDomainFields: true });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText('Failed to copy project configuration (invalid config domain fields)')).toBeInTheDocument();
        });
        expect(screen.queryByText('Configuration copied from Template Project.')).not.toBeInTheDocument();
      });

      test(`clears clone status alerts when source project selection changes for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        fireEvent.click(screen.getByRole('button', { name: 'Copy from Project' }));

        await waitFor(() => {
          expect(screen.getByText('Configuration copied from Template Project.')).toBeInTheDocument();
        });

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy-2' } });

        expect(screen.queryByText('Configuration copied from Template Project.')).not.toBeInTheDocument();
      });

      test(`filters copy source projects by matching project type for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType);

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        expect(screen.getByText(new RegExp(`Only ${projectType} source projects are listed`))).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Template Project' })).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: 'Cross-Type Project' })).not.toBeInTheDocument();
      });

      test(`shows empty-state guidance when no same-type copy sources exist for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType);
        const originalFetch = global.fetch;
        const incompatibleType = projectType === 'PT1' ? 'PT2' : 'PT1';
        global.fetch = jest.fn((url, requestOptions = {}) => {
          if (url === '/api/projects') {
            return Promise.resolve({
              ok: true,
              json: async () => [
                { id: 'proj-1', name: 'Current Project', project_type: projectType },
                { id: 'proj-cross-type', name: 'Cross-Type Project', project_type: incompatibleType },
              ],
            });
          }
          return originalFetch(url, requestOptions);
        });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());
        expect(screen.getByTestId('no-compatible-copy-sources')).toBeInTheDocument();
        expect(screen.getByLabelText('Source project')).toBeDisabled();
      });

      test(`prevents duplicate clone submissions while copy is in progress for ${projectType} ${syntheticUser} synthetic user`, async () => {
        const config = makeConfig(projectType, syntheticUser);
        mockFetch(config, projectType, { delayedClone: true });

        render(<ProjectConfigurationPanel projectId="proj-1" />);

        await waitFor(() => expect(screen.getByLabelText('Source project')).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText('Source project'), { target: { value: 'proj-copy' } });
        const copyButton = screen.getByRole('button', { name: 'Copy from Project' });

        fireEvent.click(copyButton);
        expect(screen.getByRole('button', { name: 'Copying...' })).toBeDisabled();
        expect(screen.getByLabelText('Source project')).toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: 'Copying...' }));

        await waitFor(() => {
          const cloneCalls = global.fetch.mock.calls.filter(
            ([url, options = {}]) => url === '/api/projects/proj-1/configuration/clone' && options.method === 'POST',
          );
          expect(cloneCalls).toHaveLength(1);
          expect(screen.getByText('Configuration copied from Template Project.')).toBeInTheDocument();
        });
      });
    });
  });
});
