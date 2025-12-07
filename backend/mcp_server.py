#!/usr/bin/env python3
"""
VISTA MCP Server

This MCP (Model Context Protocol) server exposes VISTA backend functionality
to external clients like Atlas-UI-3. It provides tools for managing projects,
images, classifications, and metadata.

The server trusts the username parameter passed by the client (Atlas),
which handles authentication upstream.
"""

import asyncio
import uuid
import os
import sys
from typing import Optional, List, Dict, Any
from pathlib import Path

# Add backend directory to path
backend_dir = Path(__file__).parent
sys.path.insert(0, str(backend_dir))

from fastmcp import FastMCP
from sqlalchemy.ext.asyncio import AsyncSession
from core.database import get_db
from core import schemas, models
from core.config import settings
from core.group_auth_helper import is_user_in_group
import utils.crud as crud
from utils.dependencies import get_accessible_projects_for_user
from utils.boto3_client import get_presigned_download_url

# Initialize MCP server
mcp = FastMCP("VISTA")

# Database session helper
async def get_session():
    """Get async database session."""
    async for session in get_db():
        return session

async def get_or_create_user(db: AsyncSession, username: str) -> models.User:
    """
    Get or create a user by username/email.
    Atlas provides the username, which we trust.
    """
    # Treat username as email if it contains @, otherwise use as-is
    email = username if '@' in username else f"{username}@local"
    
    user = await crud.get_user_by_email(db, email)
    if not user:
        user_create = schemas.UserCreate(
            email=email,
            username=username,
            is_active=True
        )
        user = await crud.create_user(db, user_create, created_by="mcp_server")
    
    return user


@mcp.tool()
async def get_projects(username: str, skip: int = 0, limit: int = 100) -> List[Dict[str, Any]]:
    """
    Get all projects accessible to the user.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        skip: Number of projects to skip (for pagination)
        limit: Maximum number of projects to return
        
    Returns:
        List of projects with their details
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    # Convert user model to schema for dependencies
    user_schema = schemas.User.model_validate(user)
    
    projects = await get_accessible_projects_for_user(db, user_schema, skip, limit)
    
    return [
        {
            "id": str(p.id),
            "name": p.name,
            "description": p.description,
            "meta_group_id": p.meta_group_id,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        }
        for p in projects
    ]


@mcp.tool()
async def get_project(username: str, project_id: str) -> Dict[str, Any]:
    """
    Get details of a specific project.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        project_id: UUID of the project
        
    Returns:
        Project details
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        return {"error": "Invalid project_id format"}
    
    project = await crud.get_project(db, pid)
    if not project:
        return {"error": "Project not found"}
    
    # Check user has access
    if not is_user_in_group(user.email, project.meta_group_id):
        return {"error": "Access denied to this project"}
    
    return {
        "id": str(project.id),
        "name": project.name,
        "description": project.description,
        "meta_group_id": project.meta_group_id,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "updated_at": project.updated_at.isoformat() if project.updated_at else None,
    }


@mcp.tool()
async def get_images(
    username: str,
    project_id: str,
    skip: int = 0,
    limit: int = 100,
    include_deleted: bool = False
) -> List[Dict[str, Any]]:
    """
    Get images in a project.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        project_id: UUID of the project
        skip: Number of images to skip (for pagination)
        limit: Maximum number of images to return
        include_deleted: Whether to include soft-deleted images
        
    Returns:
        List of images with their details
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        return [{"error": "Invalid project_id format"}]
    
    project = await crud.get_project(db, pid)
    if not project:
        return [{"error": "Project not found"}]
    
    # Check user has access
    if not is_user_in_group(user.email, project.meta_group_id):
        return [{"error": "Access denied to this project"}]
    
    # Get images with proper pagination handling for deleted vs non-deleted
    if include_deleted:
        # For include_deleted, we need both active and deleted images
        # Use a database query that combines both with proper pagination
        from sqlalchemy import select, or_
        from sqlalchemy.orm import selectinload
        
        query = select(models.DataInstance).where(
            models.DataInstance.project_id == pid
        ).order_by(models.DataInstance.created_at.desc())
        
        query = query.offset(skip).limit(limit)
        result = await db.execute(query)
        images = result.scalars().all()
    else:
        images = await crud.get_data_instances_for_project(
            db, pid, skip, limit
        )
    
    return [
        {
            "id": str(img.id),
            "project_id": str(img.project_id),
            "filename": img.filename,
            "content_type": img.content_type,
            "size_bytes": img.size_bytes,
            "metadata": img.metadata_json if hasattr(img, 'metadata_json') else {},
            "uploaded_by": img.uploaded_by_user_id,
            "created_at": img.created_at.isoformat() if img.created_at else None,
            "deleted_at": img.deleted_at.isoformat() if img.deleted_at else None,
        }
        for img in images
    ]


@mcp.tool()
async def get_image_info(username: str, image_id: str) -> Dict[str, Any]:
    """
    Get detailed information about a specific image.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        image_id: UUID of the image
        
    Returns:
        Image details including metadata and download URL
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        iid = uuid.UUID(image_id)
    except ValueError:
        return {"error": "Invalid image_id format"}
    
    image = await crud.get_data_instance(db, iid)
    if not image:
        return {"error": "Image not found"}
    
    # Get project and check access
    project = await crud.get_project(db, image.project_id)
    if not project:
        return {"error": "Project not found"}
    
    if not is_user_in_group(user.email, project.meta_group_id):
        return {"error": "Access denied to this image"}
    
    # Get presigned download URL
    download_url = None
    try:
        download_url = get_presigned_download_url(
            settings.S3_BUCKET,
            image.object_storage_key,
            image.filename
        )
    except Exception as e:
        download_url = f"Error generating URL: {str(e)}"
    
    return {
        "id": str(image.id),
        "project_id": str(image.project_id),
        "filename": image.filename,
        "content_type": image.content_type,
        "size_bytes": image.size_bytes,
        "metadata": image.metadata_json if hasattr(image, 'metadata_json') else {},
        "uploaded_by": image.uploaded_by_user_id,
        "created_at": image.created_at.isoformat() if image.created_at else None,
        "download_url": download_url,
        "deleted_at": image.deleted_at.isoformat() if image.deleted_at else None,
    }


@mcp.tool()
async def add_image_metadata(
    username: str,
    image_id: str,
    key: str,
    value: Any
) -> Dict[str, Any]:
    """
    Add or update a metadata field on an image.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        image_id: UUID of the image
        key: Metadata key to add/update
        value: Metadata value
        
    Returns:
        Success status and updated metadata
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        iid = uuid.UUID(image_id)
    except ValueError:
        return {"error": "Invalid image_id format"}
    
    image = await crud.get_data_instance(db, iid)
    if not image:
        return {"error": "Image not found"}
    
    # Get project and check access
    project = await crud.get_project(db, image.project_id)
    if not project:
        return {"error": "Project not found"}
    
    if not is_user_in_group(user.email, project.meta_group_id):
        return {"error": "Access denied to this image"}
    
    # Update metadata directly using SQLAlchemy
    from sqlalchemy import update
    current_metadata = image.metadata_json or {}
    current_metadata[key] = value
    
    await db.execute(
        update(models.DataInstance)
        .where(models.DataInstance.id == iid)
        .values(metadata_json=current_metadata)
    )
    await db.commit()
    
    return {
        "success": True,
        "image_id": str(iid),
        "metadata": current_metadata
    }


@mcp.tool()
async def get_image_classes(username: str, project_id: str) -> List[Dict[str, Any]]:
    """
    Get all classification labels (classes) for a project.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        project_id: UUID of the project
        
    Returns:
        List of image classes
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        return [{"error": "Invalid project_id format"}]
    
    project = await crud.get_project(db, pid)
    if not project:
        return [{"error": "Project not found"}]
    
    if not is_user_in_group(user.email, project.meta_group_id):
        return [{"error": "Access denied to this project"}]
    
    classes = await crud.get_image_classes_for_project(db, pid)
    
    return [
        {
            "id": str(c.id),
            "project_id": str(c.project_id),
            "name": c.name,
            "description": c.description,
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c in classes
    ]


@mcp.tool()
async def add_image_classification(
    username: str,
    image_id: str,
    class_id: str
) -> Dict[str, Any]:
    """
    Add a classification to an image.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        image_id: UUID of the image
        class_id: UUID of the image class
        
    Returns:
        Success status and classification details
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        iid = uuid.UUID(image_id)
        cid = uuid.UUID(class_id)
    except ValueError:
        return {"error": "Invalid UUID format"}
    
    image = await crud.get_data_instance(db, iid)
    if not image:
        return {"error": "Image not found"}
    
    # Get project and check access
    project = await crud.get_project(db, image.project_id)
    if not project:
        return {"error": "Project not found"}
    
    if not is_user_in_group(user.email, project.meta_group_id):
        return {"error": "Access denied"}
    
    # Create classification
    classification_create = schemas.ImageClassificationCreate(
        image_id=iid,
        class_id=cid,
        created_by_id=user.id
    )
    
    classification = await crud.create_image_classification(
        db, classification_create, user.email
    )
    
    return {
        "success": True,
        "id": str(classification.id),
        "image_id": str(classification.image_id),
        "class_id": str(classification.class_id),
        "created_at": classification.created_at.isoformat() if classification.created_at else None,
    }


@mcp.tool()
async def get_image_comments(username: str, image_id: str) -> List[Dict[str, Any]]:
    """
    Get comments on an image.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        image_id: UUID of the image
        
    Returns:
        List of comments
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        iid = uuid.UUID(image_id)
    except ValueError:
        return [{"error": "Invalid image_id format"}]
    
    image = await crud.get_data_instance(db, iid)
    if not image:
        return [{"error": "Image not found"}]
    
    # Get project and check access
    project = await crud.get_project(db, image.project_id)
    if not project:
        return [{"error": "Project not found"}]
    
    if not is_user_in_group(user.email, project.meta_group_id):
        return [{"error": "Access denied"}]
    
    comments = await crud.get_comments_for_image(db, iid)
    
    return [
        {
            "id": str(c.id),
            "image_id": str(c.image_id),
            "text": c.text,
            "author_id": str(c.author_id),
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c in comments
    ]


@mcp.tool()
async def add_image_comment(
    username: str,
    image_id: str,
    text: str
) -> Dict[str, Any]:
    """
    Add a comment to an image.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        image_id: UUID of the image
        text: Comment text
        
    Returns:
        Success status and comment details
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        iid = uuid.UUID(image_id)
    except ValueError:
        return {"error": "Invalid image_id format"}
    
    image = await crud.get_data_instance(db, iid)
    if not image:
        return {"error": "Image not found"}
    
    # Get project and check access
    project = await crud.get_project(db, image.project_id)
    if not project:
        return {"error": "Project not found"}
    
    if not is_user_in_group(user.email, project.meta_group_id):
        return {"error": "Access denied"}
    
    # Create comment
    comment_create = schemas.ImageCommentCreate(
        image_id=iid,
        text=text,
        author_id=user.id
    )
    
    comment = await crud.create_comment(db, comment_create, user.email)
    
    return {
        "success": True,
        "id": str(comment.id),
        "image_id": str(comment.image_id),
        "text": comment.text,
        "author_id": str(comment.author_id),
        "created_at": comment.created_at.isoformat() if comment.created_at else None,
    }


@mcp.tool()
async def create_project(
    username: str,
    name: str,
    meta_group_id: str,
    description: Optional[str] = None
) -> Dict[str, Any]:
    """
    Create a new project.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        name: Project name
        meta_group_id: Group ID for access control
        description: Optional project description
        
    Returns:
        Created project details
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    # Check if user has access to the group
    if not is_user_in_group(user.email, meta_group_id):
        return {"error": f"User does not have access to group '{meta_group_id}'"}
    
    project_create = schemas.ProjectCreate(
        name=name,
        description=description,
        meta_group_id=meta_group_id
    )
    
    project = await crud.create_project(db, project_create, created_by=user.email)
    
    return {
        "success": True,
        "id": str(project.id),
        "name": project.name,
        "description": project.description,
        "meta_group_id": project.meta_group_id,
        "created_at": project.created_at.isoformat() if project.created_at else None,
    }


@mcp.tool()
async def get_project_metadata(username: str, project_id: str) -> List[Dict[str, Any]]:
    """
    Get all metadata key-value pairs for a project.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        project_id: UUID of the project
        
    Returns:
        List of metadata entries
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        return [{"error": "Invalid project_id format"}]
    
    project = await crud.get_project(db, pid)
    if not project:
        return [{"error": "Project not found"}]
    
    if not is_user_in_group(user.email, project.meta_group_id):
        return [{"error": "Access denied"}]
    
    # Get all project metadata entries
    from sqlalchemy import select
    result = await db.execute(
        select(models.ProjectMetadata).where(models.ProjectMetadata.project_id == pid)
    )
    metadata_list = result.scalars().all()
    
    return [
        {
            "id": str(m.id),
            "project_id": str(m.project_id),
            "key": m.key,
            "value": m.value,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }
        for m in metadata_list
    ]


@mcp.tool()
async def add_project_metadata(
    username: str,
    project_id: str,
    key: str,
    value: str
) -> Dict[str, Any]:
    """
    Add or update a metadata key-value pair for a project.
    
    Args:
        username: The username/email of the user (trusted from Atlas)
        project_id: UUID of the project
        key: Metadata key
        value: Metadata value
        
    Returns:
        Success status and metadata details
    """
    db = await get_session()
    user = await get_or_create_user(db, username)
    
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        return {"error": "Invalid project_id format"}
    
    project = await crud.get_project(db, pid)
    if not project:
        return {"error": "Project not found"}
    
    if not is_user_in_group(user.email, project.meta_group_id):
        return {"error": "Access denied"}
    
    metadata_create = schemas.ProjectMetadataCreate(
        project_id=pid,
        key=key,
        value=value
    )
    
    metadata = await crud.create_or_update_project_metadata(db, metadata_create, created_by=user.email)
    
    return {
        "success": True,
        "id": str(metadata.id),
        "project_id": str(metadata.project_id),
        "key": metadata.key,
        "value": metadata.value,
        "created_at": metadata.created_at.isoformat() if metadata.created_at else None,
    }


if __name__ == "__main__":
    # Run the MCP server
    mcp.run()
