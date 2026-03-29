import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

test('renders image management platform header', () => {
  global.fetch = jest.fn((input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/api/users/me')) {
      return Promise.resolve({ ok: false, status: 401, json: async () => ({ detail: 'Unauthorized' }) });
    }
    if (url.endsWith('/api/projects/')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  render(
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
  const headerElement = screen.getByText('VISTA an Image Management System');
  expect(headerElement).toBeInTheDocument();
});

describe('project type UI exposure', () => {
  const projectTypes = ['PT1', 'PT2', 'PT3'];
  const simulatedUsers = [
    { label: 'basic', complexity: 1 },
    { label: 'intermediate', complexity: 2 },
    { label: 'advanced', complexity: 3 },
  ];

  function mockDashboardFetches({ projectType, userScenario }) {
    global.fetch = jest.fn((input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init.method || 'GET').toUpperCase();

      if (url.endsWith('/api/users/me')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ email: `${userScenario.label}-${projectType.toLowerCase()}@example.com` }),
        });
      }

      if (url.endsWith('/api/projects/') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ([
            {
              id: `proj-${projectType.toLowerCase()}-${userScenario.label}`,
              name: `${projectType} ${userScenario.label} synthetic`,
              description: `complexity-${userScenario.complexity}`,
              meta_group_id: `${projectType.toLowerCase()}-${userScenario.label}-group`,
              project_type: projectType,
            },
          ]),
        });
      }

      if (url.endsWith('/api/projects/') && method === 'POST') {
        const payload = JSON.parse(init.body || '{}');
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            id: `new-${projectType.toLowerCase()}-${userScenario.label}`,
            ...payload,
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    });
  }

  afterEach(() => {
    jest.resetAllMocks();
  });

  test.each(projectTypes.flatMap((projectType) => simulatedUsers.map((userScenario) => ({ projectType, userScenario }))))(
    'shows selected project type for $projectType $userScenario.label simulated workflow',
    async ({ projectType, userScenario }) => {
      mockDashboardFetches({ projectType, userScenario });
      const user = userEvent.setup();

      render(
        <BrowserRouter>
          <App />
        </BrowserRouter>
      );

      expect(await screen.findByText(new RegExp(`Type: ${projectType}`))).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'New Project' }));
      await user.type(screen.getByLabelText('Project Name *'), `${projectType} ${userScenario.label} created`);
      await user.type(screen.getByLabelText('Access Group *'), `${projectType.toLowerCase()}-${userScenario.label}-new-group`);
      await user.selectOptions(screen.getByLabelText('Project Type *'), projectType);
      await user.click(screen.getByRole('button', { name: 'Create Project' }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/projects/',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining(`"project_type":"${projectType}"`),
          })
        );
      });
    }
  );

  test('keeps selected project type on dashboard card even if create response omits project_type', async () => {
    global.fetch = jest.fn((input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init.method || 'GET').toUpperCase();

      if (url.endsWith('/api/users/me')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ email: 'pt2-user@example.com' }),
        });
      }

      if (url.endsWith('/api/projects/') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ([]),
        });
      }

      if (url.endsWith('/api/projects/') && method === 'POST') {
        const payload = JSON.parse(init.body || '{}');
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            id: 'created-pt2',
            name: payload.name,
            description: payload.description,
            meta_group_id: payload.meta_group_id,
          }),
        });
      }

      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });

    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>
    );

    await user.click(await screen.findByRole('button', { name: 'Create Your First Project' }));
    await user.type(screen.getByLabelText('Project Name *'), 'Test PT2');
    await user.type(screen.getByLabelText('Access Group *'), 'pt2-group');
    await user.selectOptions(screen.getByLabelText('Project Type *'), 'PT2');
    await user.click(screen.getByRole('button', { name: 'Create Project' }));

    expect(await screen.findByText(/Type: PT2/)).toBeInTheDocument();
  });

  test('shows project card ellipsis menu and allows editing name and type', async () => {
    global.fetch = jest.fn((input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init.method || 'GET').toUpperCase();

      if (url.endsWith('/api/users/me')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ email: 'editor@example.com' }),
        });
      }

      if (url.endsWith('/api/projects/') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ([
            {
              id: 'project-1',
              name: 'Project Original',
              description: 'Original description',
              meta_group_id: 'g1',
              project_type: 'PT1',
            },
          ]),
        });
      }

      if (url.endsWith('/api/projects/project-1') && method === 'PUT') {
        const payload = JSON.parse(init.body || '{}');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'project-1',
            meta_group_id: 'g1',
            ...payload,
          }),
        });
      }

      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });

    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>
    );

    await screen.findByText('Project Original');
    await user.click(screen.getByRole('button', { name: /Project options for Project Original/i }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    const nameInput = screen.getByLabelText('Project Name *');
    await user.clear(nameInput);
    await user.type(nameInput, 'Project Edited');
    await user.selectOptions(screen.getByLabelText('Project Type *'), 'PT2');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('Project Edited')).toBeInTheDocument();
    expect(screen.getByText(/Type: PT2/)).toBeInTheDocument();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/project-1',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"project_type":"PT2"'),
        })
      );
    });
  });
});
