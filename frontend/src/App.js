import React, { useState, useEffect, lazy, Suspense, memo, useRef, useCallback } from 'react';
import { Route, Routes, Link, useLocation } from 'react-router-dom';
import './App.css';
import Toast from './components/Toast';

// Lazy load components
const Project = lazy(() => import('./Project'));
const ImageView = lazy(() => import('./ImageView'));
const ApiKeys = lazy(() => import('./ApiKeys'));
const ProjectReport = lazy(() => import('./components/ProjectReport'));
const GroupGalleryView = lazy(() => import('./components/GroupGalleryView'));

// Debug counter to track renders
let renderCount = 0;

// Create a separate component for the modal form
const CreateProjectModal = memo(function CreateProjectModal({ onClose, onSubmit, currentUser }) {
  console.log("Modal render count:", ++renderCount);
  
  // Use refs for uncontrolled inputs
  const nameInputRef = useRef(null);
  const descriptionInputRef = useRef(null);
  const groupIdInputRef = useRef(null);
  const projectTypeInputRef = useRef(null);
  
  // Track focus state for debugging
  const [focusState, setFocusState] = useState('none');
  
  // Handle form submission
  const handleSubmit = (e) => {
    e.preventDefault();
    console.log("Form submitted");
    
    // Get values directly from refs
    const newProject = {
      name: nameInputRef.current.value,
      description: descriptionInputRef.current.value,
      meta_group_id: groupIdInputRef.current.value,
      project_type: projectTypeInputRef.current.value,
    };
    
    onSubmit(newProject);
  };
  
  // Debug focus events
  const handleFocus = (fieldName) => {
    console.log(`Focus on: ${fieldName}`);
    setFocusState(fieldName);
  };
  
  const handleBlur = (fieldName) => {
    console.log(`Blur from: ${fieldName}`);
    if (focusState === fieldName) {
      setFocusState('none');
    }
  };
  
  // Fetch available groups when component mounts
  useEffect(() => {
    console.log("Modal component mounted");
    
    // Focus the name input when modal opens
    if (nameInputRef.current) {
      nameInputRef.current.focus();
    }
    
    return () => {
      console.log("Modal component unmounted");
    };
  }, []);
  
  return (
    <div className="modal">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Create New Project</h3>
          <span className="close" onClick={onClose}>&times;</span>
        </div>
        <div className="modal-body">
          <form id="create-project-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="name">Project Name *</label>
              <input 
                type="text" 
                id="name" 
                ref={nameInputRef}
                onFocus={() => handleFocus('name')}
                onBlur={() => handleBlur('name')}
                required
                placeholder="Enter a descriptive project name"
                className="form-control"
              />
              <small className="form-text">
                Choose a clear, descriptive name for your project
              </small>
            </div>
            
            <div className="form-group">
              <label htmlFor="description">Description</label>
              <textarea 
                id="description" 
                rows="3"
                ref={descriptionInputRef}
                onFocus={() => handleFocus('description')}
                onBlur={() => handleBlur('description')}
                placeholder="Describe what this project is for..."
                className="form-control"
              ></textarea>
              <small className="form-text">
                Optional: Add more details about your project's purpose
              </small>
            </div>
            
            <div className="form-group">
              <label htmlFor="meta_group_id">Access Group *</label>
              <input 
                type="text" 
                id="meta_group_id" 
                ref={groupIdInputRef}
                onFocus={() => handleFocus('groupId')}
                onBlur={() => handleBlur('groupId')}
                required
                placeholder="Enter the group ID you have access to"
                className="form-control"
              />
              <small className="form-text">
                Enter the ID of a group you are a member of
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="project_type">Project Type *</label>
              <select
                id="project_type"
                ref={projectTypeInputRef}
                defaultValue="PT1"
                onFocus={() => handleFocus('projectType')}
                onBlur={() => handleBlur('projectType')}
                className="form-control"
              >
                <option value="PT1">PT1 — External Multi-View</option>
                <option value="PT2">PT2 — 3D Slice Review</option>
                <option value="PT3">PT3 — Advanced 3D Slice Review</option>
              </select>
              <small className="form-text">
                Select the project workflow mode used by inspection workbench tools
              </small>
            </div>
          </form>
        </div>
        <div className="modal-footer">
          <button 
            type="button" 
            className="btn btn-secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button 
            type="submit" 
            form="create-project-form"
            className="btn btn-success btn-large"
          >
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
});

const EditProjectModal = memo(function EditProjectModal({ project, onClose, onSubmit }) {
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [projectType, setProjectType] = useState(project?.project_type || 'PT1');

  useEffect(() => {
    setName(project?.name || '');
    setDescription(project?.description || '');
    setProjectType(project?.project_type || 'PT1');
  }, [project]);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({
      name,
      description,
      project_type: projectType,
    });
  };

  if (!project) return null;

  return (
    <div className="modal">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Edit Project</h3>
          <span className="close" onClick={onClose}>&times;</span>
        </div>
        <div className="modal-body">
          <form id="edit-project-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="edit_name">Project Name *</label>
              <input
                type="text"
                id="edit_name"
                className="form-control"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="edit_description">Description</label>
              <textarea
                id="edit_description"
                rows="3"
                className="form-control"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              ></textarea>
            </div>
            <div className="form-group">
              <label htmlFor="edit_project_type">Project Type *</label>
              <select
                id="edit_project_type"
                className="form-control"
                value={projectType}
                onChange={(e) => setProjectType(e.target.value)}
              >
                <option value="PT1">PT1 — External Multi-View</option>
                <option value="PT2">PT2 — 3D Slice Review</option>
                <option value="PT3">PT3 — Advanced 3D Slice Review</option>
              </select>
            </div>
          </form>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="edit-project-form" className="btn btn-success btn-large">
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
});

const DeleteProjectModal = memo(function DeleteProjectModal({ project, onClose, onConfirm }) {
  const [confirmationPhrase, setConfirmationPhrase] = useState('');
  const expectedPhrase = project ? `DELETE ${project.name}` : '';

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!project) return;
    onConfirm(project, confirmationPhrase);
  };

  if (!project) return null;

  return (
    <div className="modal">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Delete Project</h3>
          <span className="close" onClick={onClose}>&times;</span>
        </div>
        <div className="modal-body">
          <p>
            This action permanently deletes <strong>{project.name}</strong> and related project data.
          </p>
          <p>
            To confirm, type <code>{expectedPhrase}</code>.
          </p>
          <form id="delete-project-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="delete_confirmation_phrase">Confirmation phrase *</label>
              <input
                id="delete_confirmation_phrase"
                type="text"
                className="form-control"
                value={confirmationPhrase}
                onChange={(e) => setConfirmationPhrase(e.target.value)}
                placeholder={expectedPhrase}
                required
              />
            </div>
          </form>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="delete-project-form" className="btn btn-danger btn-large">
            Delete Project
          </button>
        </div>
      </div>
    </div>
  );
});

// Memoized ProjectItem component to prevent unnecessary re-renders
const ProjectItem = memo(function ProjectItem({ project, onEdit, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="project-card">
      <div className="project-card-header">
        <div className="project-card-header-row">
          <Link
            to={`/project/${project.id}`}
            className="project-card-link-title"
          >
          <h3 className="project-card-title">{project.name}</h3>
          </Link>
          <div className="project-card-menu">
            <button
              type="button"
              className="project-card-menu-button"
              aria-label={`Project options for ${project.name}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenuOpen((prev) => !prev);
              }}
            >
              …
            </button>
            {menuOpen && (
              <div className="project-card-menu-dropdown">
                <button
                  type="button"
                  className="project-card-menu-item"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuOpen(false);
                    onEdit(project);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="project-card-menu-item"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuOpen(false);
                    onDelete(project);
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
        <Link
          to={`/project/${project.id}`}
          style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
        >
          <div className="project-card-meta">
            ID: {project.id} • Group: {project.meta_group_id} • Type: {project.project_type || 'PT1'}
          </div>
        </Link>
      </div>
      <Link 
        to={`/project/${project.id}`} 
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        <div className="project-card-body">
          <p className="project-card-description">
            {project.description || 'No description provided'}
          </p>
        </div>
      </Link>
    </div>
  );
});

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function App() {
  // const navigate = useNavigate(); // Commented out - not currently used
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  const [deletingProject, setDeletingProject] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  // const [newProject, setNewProject] = useState({  // Commented out - not currently used
  //   name: '',
  //   description: '',
  //   meta_group_id: ''
  // });
  
  // Function to show a toast notification
  const showToast = (message, type = 'error') => {
    setToast({ message, type });
  };
  
  // Function to hide the toast
  const hideToast = () => {
    setToast(null);
  };

  useEffect(() => {
    // Fetch the current user
    fetch('/api/users/me')
      .then(response => {
        if (!response.ok) {
          // If we get a 401, it's expected when authentication is disabled
          if (response.status === 401) {
            console.log("Authentication is disabled or user is not logged in");
            return null;
          }
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(userData => {
        if (userData) {
          setCurrentUser(userData);
        }
      })
      .catch(err => {
        console.error("Failed to fetch current user:", err);
      });

    // Fetch projects from the API
    fetch('/api/projects/')
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        setProjects(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch projects:", err);
        showToast(`Failed to fetch projects: ${err.message}`, 'error');
        setLoading(false);
      });
  }, []); // Empty dependency array means this effect runs once on mount

  // Log component renders for debugging
  console.log("App render count:", ++renderCount);
  
  // Handle project creation form submission
  const handleCreateProject = useCallback((projectData) => {
    console.log("Creating project:", projectData);
    setLoading(true);
    
    fetch('/api/projects/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(projectData),
    })
      .then(response => {
        if (!response.ok) {
          // Parse the error response
          return response.json().then(errorData => {
            throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
          }).catch(jsonError => {
            // If parsing JSON fails, use a generic error message
            throw new Error(`HTTP error! status: ${response.status}`);
          });
        }
        return response.json();
      })
      .then(data => {
        const normalized = {
          ...data,
          project_type: data.project_type || projectData.project_type || 'PT1',
        };
        console.log("Project created successfully:", data);
        // Add the new project to the projects list
        setProjects(prev => [...prev, normalized]);
        // Close modal
        setShowModal(false);
        setLoading(false);
        // Show success toast
        showToast(`Project "${normalized.name}" created successfully!`, 'success');
      })
      .catch(err => {
        console.error("Failed to create project:", err);
        showToast(err.message, 'error');
        setLoading(false);
      });
  }, []);

  const handleEditProject = useCallback((project) => {
    setEditingProject(project);
  }, []);

  const handleUpdateProject = useCallback((updatedData) => {
    if (!editingProject) return;
    setLoading(true);

    fetch(`/api/projects/${editingProject.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updatedData),
    })
      .then(response => {
        if (!response.ok) {
          return response.json().then((errorData) => {
            throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
          });
        }
        return response.json();
      })
      .then((savedProject) => {
        setProjects((prev) => prev.map((p) => (p.id === savedProject.id ? savedProject : p)));
        setEditingProject(null);
        setLoading(false);
        showToast(`Project "${savedProject.name}" updated successfully!`, 'success');
      })
      .catch((err) => {
        console.error('Failed to update project:', err);
        showToast(err.message, 'error');
        setLoading(false);
      });
  }, [editingProject]);

  const handleDeleteProject = useCallback((project) => {
    setDeletingProject(project);
  }, []);

  const handleConfirmDeleteProject = useCallback((project, confirmationPhrase) => {
    if (!project) return;
    setLoading(true);

    fetch(`/api/projects/${project.id}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ confirmation_phrase: confirmationPhrase }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
        }
      })
      .then(() => {
        setProjects((prev) => prev.filter((candidate) => candidate.id !== project.id));
        setDeletingProject(null);
        setLoading(false);
        showToast(`Project "${project.name}" deleted successfully.`, 'success');
      })
      .catch((err) => {
        console.error('Failed to delete project:', err);
        showToast(err.message, 'error');
        setLoading(false);
      });
  }, []);


  const HomePage = () => (
    <div className="App">
      <header className="App-header">
        <div className="header-content">
          <div className="header-title">
            <h1>VISTA an Image Management System</h1>
            {currentUser && (
              <div className="user-info">
                <span>Welcome back, {currentUser.email}</span>
              </div>
            )}
          </div>
          <div className="header-actions">
            <Link to="/api-keys" className="btn btn-secondary">
              API Keys
            </Link>
            <button 
              className="btn btn-primary btn-large" 
              onClick={() => setShowModal(true)}
            >
              New Project
            </button>
          </div>
        </div>
      </header>

      <div className="container">
        {/* Toast notification */}
        {toast && (
          <Toast 
            message={toast.message}
            type={toast.type}
            onClose={hideToast}
            duration={5000}
          />
        )}
        
        {/* Projects Section */}
        <div className="nav-breadcrumb">
          <div className="breadcrumb">
            <div className="breadcrumb-item">
              <span>Dashboard</span>
            </div>
            <span className="breadcrumb-separator">/</span>
            <div className="breadcrumb-item">
              <span>Projects</span>
            </div>
          </div>
        </div>

        {loading && (
          <div className="loading-container">
            <div className="spinner"></div>
            <div className="loading-text">Loading your projects...</div>
          </div>
        )}
        
        {!loading && projects.length === 0 && (
          <div className="card text-center">
            <div className="card-content">
              <div style={{ fontSize: '4rem', marginBottom: 'var(--space-4)' }}>+</div>
              <h3 style={{ marginBottom: 'var(--space-4)', color: 'var(--gray-600)' }}>
                No projects yet
              </h3>
              <p style={{ color: 'var(--gray-500)', marginBottom: 'var(--space-6)' }}>
                Get started by creating your first image management project
              </p>
              <button 
                className="btn btn-primary btn-large"
                onClick={() => setShowModal(true)}
              >
                Create Your First Project
              </button>
            </div>
          </div>
        )}
        
        {!loading && projects.length > 0 && (
          <>
            <div className="flex justify-between items-center mb-6">
              <h2 style={{ margin: 0, color: 'var(--gray-900)', fontSize: '1.5rem', fontWeight: '600' }}>
                Your Projects ({projects.length})
              </h2>
              <div className="flex gap-4">
                <span style={{ fontSize: '0.875rem', color: 'var(--gray-500)' }}>
                  {projects.length} {projects.length === 1 ? 'project' : 'projects'} total
                </span>
              </div>
            </div>
            <div className="projects-grid">
              {projects.map(project => (
                <ProjectItem key={project.id} project={project} onEdit={handleEditProject} onDelete={handleDeleteProject} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Create Project Modal - Now using a separate component */}
      {showModal && (
        <CreateProjectModal 
          onClose={() => setShowModal(false)} 
          onSubmit={handleCreateProject}
          currentUser={currentUser}
        />
      )}
      {editingProject && (
        <EditProjectModal
          project={editingProject}
          onClose={() => setEditingProject(null)}
          onSubmit={handleUpdateProject}
        />
      )}
      {deletingProject && (
        <DeleteProjectModal
          project={deletingProject}
          onClose={() => setDeletingProject(null)}
          onConfirm={handleConfirmDeleteProject}
        />
      )}
    </div>
  );

  return (
    <>
    <ScrollToTop />
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route
        path="/project/:id"
        element={
          <Suspense fallback={<div className="loading-container">Loading project...</div>}>
            <Project />
          </Suspense>
        }
      />
      <Route
        path="/project/:id/report"
        element={
          <Suspense fallback={<div className="loading-container">Loading report...</div>}>
            <ProjectReport />
          </Suspense>
        }
      />
      <Route
        path="/project/:id/group/:groupId"
        element={
          <Suspense fallback={<div className="loading-container">Loading group...</div>}>
            <GroupGalleryView />
          </Suspense>
        }
      />
      <Route
        path="/project/:id/ungrouped"
        element={
          <Suspense fallback={<div className="loading-container">Loading ungrouped images...</div>}>
            <GroupGalleryView />
          </Suspense>
        }
      />
      <Route
        path="/view/:imageId"
        element={
          <Suspense fallback={<div className="loading-container">Loading image...</div>}>
            <ImageView />
          </Suspense>
        }
      />
      <Route 
        path="/api-keys" 
        element={
          <Suspense fallback={<div className="loading-container">Loading API keys...</div>}>
            <ApiKeys />
          </Suspense>
        } 
      />
    </Routes>
    </>
  );
}

export default App;
