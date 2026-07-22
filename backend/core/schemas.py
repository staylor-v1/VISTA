import math
import uuid
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime
import logging

from .project_types import DEFAULT_PROJECT_TYPE, PROJECT_TYPE_PATTERN

logger = logging.getLogger(__name__)

# User schemas
class UserBase(BaseModel):
    email: EmailStr
    username: Optional[str] = None
    is_active: bool = True
    groups: Optional[List[str]] = None

class UserCreate(UserBase):
    pass

class User(UserBase):
    id: Optional[uuid.UUID] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

# Project schemas
class ProjectBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    meta_group_id: str = Field(..., min_length=1, max_length=255)
    project_type: str = Field(default=DEFAULT_PROJECT_TYPE, pattern=PROJECT_TYPE_PATTERN)

    @field_validator("project_type", mode="before")
    @classmethod
    def normalize_project_type(cls, v: str) -> str:
        if isinstance(v, str):
            return v.strip().upper()
        return v

class ProjectCreate(ProjectBase):
    pass

class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    meta_group_id: Optional[str] = Field(default=None, min_length=1, max_length=255)
    project_type: Optional[str] = Field(default=None, pattern=PROJECT_TYPE_PATTERN)

    @field_validator("project_type", mode="before")
    @classmethod
    def normalize_project_type(cls, v: Optional[str]) -> Optional[str]:
        if isinstance(v, str):
            return v.strip().upper()
        return v


class ProjectDeleteRequest(BaseModel):
    confirmation_phrase: str = Field(..., min_length=1, max_length=512)


class ProjectDeleteResponse(BaseModel):
    project_id: uuid.UUID
    deleted: bool = True
    deleted_by: EmailStr


class Project(ProjectBase):
    id: uuid.UUID
    created_at: datetime
    updated_at: Optional[datetime] = None
    created_by: Optional[str] = None
    is_archived: bool = False
    archived_at: Optional[datetime] = None
    image_count: int = 0
    part_count: int = 0

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }


class ProjectDataSummary(BaseModel):
    """Small aggregate used when opening a project with a large data set."""

    project_id: uuid.UUID
    active_image_count: int = Field(ge=0)
    deleted_image_count: int = Field(ge=0)
    total_image_bytes: int = Field(ge=0)
    part_count: int = Field(ge=0)
    image_metadata_fields: int = Field(
        ge=0,
        description="Total number of top-level metadata fields across active images",
    )
    annotation_count: int = Field(ge=0)
    overlay_layer_count: int = Field(ge=0)


class InspectionBatchBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    owner: Optional[str] = Field(None, max_length=255)
    status: str = Field(default="not_started", pattern=r"^(not_started|in_progress|complete)$")


class InspectionBatchCreate(InspectionBatchBase):
    pass


class InspectionBatchUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    owner: Optional[str] = Field(None, max_length=255)
    status: Optional[str] = Field(default=None, pattern=r"^(not_started|in_progress|complete)$")


class InspectionBatch(InspectionBatchBase):
    id: uuid.UUID
    project_id: uuid.UUID
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }


class InspectionPartBase(BaseModel):
    serial_number: str = Field(..., min_length=1, max_length=255)
    display_name: Optional[str] = Field(None, max_length=255)
    metadata_json: Optional[Dict[str, Any]] = Field(
        None,
        validation_alias="metadata",
        serialization_alias="metadata",
    )
    review_state: str = Field(default="unreviewed", pattern=r"^(unreviewed|in_review|pass|reject_pending|reject_confirmed)$")

    @field_validator("serial_number")
    @classmethod
    def strip_serial_number(cls, v: str) -> str:
        return v.strip()


class InspectionPartCreate(InspectionPartBase):
    batch_id: Optional[uuid.UUID] = None


class InspectionPartUpdate(BaseModel):
    review_state: str = Field(pattern=r"^(unreviewed|in_review|pass|reject_pending|reject_confirmed)$")


class InspectionPartBatchAssignmentRequest(BaseModel):
    part_id: uuid.UUID
    to_batch_id: Optional[uuid.UUID] = None


class InspectionPartBatchAssignmentResponse(BaseModel):
    project_id: uuid.UUID
    part_id: uuid.UUID
    to_batch_id: Optional[uuid.UUID] = None


class InspectionPartManualFlagUpdateRequest(BaseModel):
    manual_flagged: bool = False


class InspectionPartMetadataSourcesUpdateRequest(BaseModel):
    metadata_source_keys: List[str] = Field(default_factory=list, max_length=100)

    @field_validator("metadata_source_keys")
    @classmethod
    def normalize_metadata_source_keys(cls, v: List[str]) -> List[str]:
        normalized: List[str] = []
        seen: set[str] = set()
        for key in v or []:
            safe_key = str(key or "").strip()
            if not safe_key or safe_key in seen:
                continue
            if len(safe_key) > 255:
                raise ValueError("metadata source keys must be 255 characters or fewer")
            seen.add(safe_key)
            normalized.append(safe_key)
        return normalized


class PT3SplatTransferFunction(BaseModel):
    threshold: float = Field(default=1.0)
    intensity_min: float = Field(default=0.0)
    intensity_max: float = Field(default=255.0)
    opacity_min: float = Field(default=0.05, ge=0.0, le=1.0)
    opacity_max: float = Field(default=1.0, ge=0.0, le=1.0)
    color_map: str = Field(default="grayscale", pattern=r"^(grayscale|hot)$")


class PT3SplatConversionRequest(BaseModel):
    source_path: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=2048,
        deprecated=True,
        description=(
            "Deprecated and rejected by project-part conversion routes; "
            "sources are materialized from images attached to the part"
        ),
    )
    volume_stack_id: Optional[str] = Field(default=None, max_length=255)
    source_image_ids: List[str] = Field(default_factory=list, max_length=1000)
    transfer_function: PT3SplatTransferFunction = Field(default_factory=PT3SplatTransferFunction)
    downsample: int = Field(default=1, ge=1)
    max_splats: int = Field(default=100_000, ge=1, le=100_000, strict=True)
    output_format: str = Field(default="ply", pattern=r"^(ply|splat|json)$")


class PT3SplatConversionResponse(BaseModel):
    asset_path: str
    asset_url: str
    cache_key: str
    output_format: str
    splat_count: int
    metadata: Dict[str, Any]


class PT3SplatGenerationStatus(BaseModel):
    status: str = Field(..., pattern=r"^(missing|pending|ready|failed)$")
    part_id: Optional[uuid.UUID] = None
    volume_stack_id: Optional[str] = None
    asset_url: Optional[str] = None
    cache_key: Optional[str] = None
    output_format: Optional[str] = None
    splat_count: Optional[int] = None
    error: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class PT3RealSplatCamera(BaseModel):
    """Undistorted pinhole camera in the fixed PT3 patient-space convention.

    ``rotation_quaternion`` is a normalized ``[w, x, y, z]`` quaternion for
    the patient-physical-to-camera rotation and ``translation`` is the matching
    physical-unit vector in ``x_camera = R * x_patient + translation``. Camera
    axes are right-handed with +X image-right, +Y image-down, and +Z forward.
    """

    image_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Unique calibrated/generated view ID; it never selects a voxel source file.",
    )
    width: int = Field(..., ge=1, strict=True, description="Undistorted image width in pixels.")
    height: int = Field(..., ge=1, strict=True, description="Undistorted image height in pixels.")
    intrinsics: List[float] = Field(
        ...,
        min_length=9,
        max_length=9,
        description="Row-major 3x3 pinhole K matrix in pixel units; input views must already be undistorted.",
    )
    rotation_quaternion: List[float] = Field(
        ...,
        min_length=4,
        max_length=4,
        description="Normalized [w,x,y,z] quaternion mapping patient-physical axes into camera axes.",
    )
    translation: List[float] = Field(
        ...,
        min_length=3,
        max_length=3,
        description="World-to-camera translation in the volume's physical units: x_camera=R*x_patient+t.",
    )

    @field_validator("image_id")
    @classmethod
    def normalize_image_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("image_id must not be blank")
        return normalized

    @field_validator("intrinsics", "rotation_quaternion", "translation", mode="before")
    @classmethod
    def require_finite_vector(cls, value):
        if isinstance(value, (str, bytes)) or not isinstance(value, (list, tuple)):
            raise ValueError("camera vectors must be arrays of numbers")
        if any(isinstance(item, bool) for item in value):
            raise ValueError("camera vectors must contain only numbers")
        try:
            values = [float(item) for item in value]
        except (TypeError, ValueError) as exc:
            raise ValueError("camera vectors must contain only numbers") from exc
        if not all(math.isfinite(item) for item in values):
            raise ValueError("camera vectors must contain only finite numbers")
        return values

    @model_validator(mode="after")
    def validate_calibration(self):
        fx, fy = self.intrinsics[0], self.intrinsics[4]
        cx, cy = self.intrinsics[2], self.intrinsics[5]
        if fx <= 0 or fy <= 0:
            raise ValueError("camera focal lengths must be positive")
        if not (0 <= cx <= self.width and 0 <= cy <= self.height):
            raise ValueError("camera principal point must lie inside the image")
        if abs(self.intrinsics[6]) > 1e-8 or abs(self.intrinsics[7]) > 1e-8 or abs(self.intrinsics[8] - 1.0) > 1e-8:
            raise ValueError("camera intrinsics must be a calibrated 3x3 homogeneous matrix")
        norm = math.sqrt(sum(component * component for component in self.rotation_quaternion))
        if norm <= 1e-12:
            raise ValueError("camera rotation quaternion must be nonzero")
        self.rotation_quaternion = [component / norm for component in self.rotation_quaternion]
        return self


class PT3RealSplatOptimizationParameters(BaseModel):
    # Canonical v1 is JSON and the bundled reference fitter/Canvas renderer are
    # deliberately dependency-light. Keep this bounded until a binary/GPU path
    # replaces the current interchange and rasterization pipeline.
    max_splats: int = Field(default=50_000, ge=1, le=100_000, strict=True)
    iterations: int = Field(default=30_000, ge=1, le=100_000, strict=True)
    sh_degree: int = Field(default=0, ge=0, le=4, strict=True)
    optimize_camera_poses: bool = Field(default=False, strict=True)
    optimize_means: Literal[True] = True
    optimize_covariance: Literal[True] = True
    optimize_rotation: Literal[True] = True
    optimize_opacity: Literal[True] = True
    optimize_spherical_harmonics: Literal[True] = True
    densification_interval: int = Field(default=100, ge=1, le=10_000, strict=True)
    convergence_tolerance: float = Field(default=1e-5, gt=0.0, le=1.0, strict=True, allow_inf_nan=False)
    density_threshold: Optional[float] = Field(default=None, strict=True, allow_inf_nan=False)
    scalar_similarity: float = Field(default=0.05, ge=0.0, le=1.0, strict=True, allow_inf_nan=False)
    opacity_min: float = Field(default=0.02, ge=0.0, le=1.0, strict=True, allow_inf_nan=False)
    opacity_max: float = Field(default=0.98, ge=0.0, le=1.0, strict=True, allow_inf_nan=False)

    @field_validator(
        "optimize_means",
        "optimize_covariance",
        "optimize_rotation",
        "optimize_opacity",
        "optimize_spherical_harmonics",
        mode="before",
    )
    @classmethod
    def require_literal_true_optimization_flags(cls, value):
        if value is not True:
            raise ValueError("Real 3DGS optimize_* flags must be the JSON boolean true")
        return value

    @model_validator(mode="after")
    def validate_density_mapping(self):
        if self.opacity_max < self.opacity_min:
            raise ValueError("opacity_max must be greater than or equal to opacity_min")
        return self


class PT3RealSplatOptimizationRequest(BaseModel):
    """Request a voxel fit or a provider fit under the canonical PT3 v1 frame.

    Provider modes use ``coordinate_space=physical``, ``camera_model=pinhole``,
    and ``camera_convention=pt3_patient_physical_w2c_wxyz/v1``. Those fixed
    values are supplied to the trusted provider and required in its asset.
    """

    fit_mode: Literal["voxel_direct", "synthetic_views", "hybrid"] = "voxel_direct"
    volume_stack_id: Optional[str] = Field(default=None, max_length=255)
    source_image_ids: List[str] = Field(default_factory=list, max_length=1000)
    cameras: List[PT3RealSplatCamera] = Field(default_factory=list, max_length=1000)
    parameters: PT3RealSplatOptimizationParameters = Field(default_factory=PT3RealSplatOptimizationParameters)

    @model_validator(mode="before")
    @classmethod
    def infer_legacy_camera_mode(cls, value):
        if isinstance(value, dict):
            normalized = dict(value)
            if "fit_mode" not in normalized and normalized.get("cameras"):
                normalized["fit_mode"] = "synthetic_views"
            if normalized.get("fit_mode") in {"synthetic_views", "hybrid"}:
                parameters = dict(normalized.get("parameters") or {})
                parameters.setdefault("sh_degree", 3)
                parameters.setdefault("optimize_camera_poses", True)
                normalized["parameters"] = parameters
            return normalized
        return value

    @field_validator("source_image_ids", mode="before")
    @classmethod
    def normalize_source_image_ids(cls, value):
        if value is None:
            return []
        if not isinstance(value, (list, tuple)):
            raise ValueError("source_image_ids must be an array")
        normalized = [str(item).strip() for item in value]
        if any(not item for item in normalized):
            raise ValueError("source_image_ids must not contain blank IDs")
        return normalized

    @model_validator(mode="after")
    def require_unique_image_ids(self):
        camera_ids = [camera.image_id for camera in self.cameras]
        if len(camera_ids) != len(set(camera_ids)):
            raise ValueError("camera image_id values must be unique")
        if len(self.source_image_ids) != len(set(self.source_image_ids)):
            raise ValueError("source_image_ids must be unique")
        if self.fit_mode == "voxel_direct":
            if self.cameras:
                raise ValueError("voxel_direct fitting does not accept camera views")
            if self.parameters.optimize_camera_poses:
                raise ValueError("voxel_direct fitting does not use or optimize camera poses")
            if self.parameters.sh_degree != 0:
                raise ValueError("voxel_direct fitting requires degree-0 spherical harmonics")
        else:
            if len(self.cameras) < 2:
                raise ValueError(f"{self.fit_mode} requires at least two calibrated or generated camera views")
            if not self.parameters.optimize_camera_poses:
                raise ValueError(f"{self.fit_mode} requires camera-pose optimization")
        return self


class PT3RealSplatGenerationStatus(BaseModel):
    status: str = Field(..., pattern=r"^(missing|pending|ready|failed|unavailable)$")
    job_id: Optional[str] = None
    part_id: Optional[uuid.UUID] = None
    volume_stack_id: Optional[str] = None
    asset_url: Optional[str] = None
    cache_key: Optional[str] = None
    splat_count: Optional[int] = None
    progress_percent: float = Field(default=0.0, ge=0.0, le=100.0)
    stage: str = ""
    error: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class InspectionPartSourceImageUpdateRequest(BaseModel):
    crop_subtitle: Optional[str] = Field(default=None, max_length=255)


class InspectionPart(InspectionPartBase):
    id: uuid.UUID
    project_id: uuid.UUID
    batch_id: Optional[uuid.UUID] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }


class InspectionSegmentationInvokeRequest(BaseModel):
    axis: str = Field(default="axial", pattern=r"^(axial|coronal|sagittal)$")
    slice_index: int = Field(default=0, ge=0)


class InspectionSegmentationInvokeResponse(BaseModel):
    run_id: uuid.UUID
    part_id: uuid.UUID
    axis: str
    slice_index: int
    status: str
    overlay_id: str
    created_at: datetime


class InspectionSliceSegmentationRequest(BaseModel):
    axis: str = Field(default="axial", pattern=r"^(axial|coronal|sagittal)$")
    slice_index: int = Field(default=0, ge=0)
    method_id: str = Field(..., min_length=1, max_length=128, pattern=r"^[a-z0-9_.-]+$")
    parameters: Dict[str, Any] = Field(default_factory=dict)
    image_data_base64: str = Field(..., min_length=1)
    filename: str = Field(default="slice.png", min_length=1, max_length=255)
    click_x: float = Field(..., ge=0)
    click_y: float = Field(..., ge=0)


class InspectionSliceSegmentRegion(BaseModel):
    label: int
    area_px: float
    bbox: List[float]
    centroid: Optional[List[float]] = None
    confidence: Optional[float] = None
    class_name: Optional[str] = None


class InspectionSliceSegmentationResponse(BaseModel):
    run_id: uuid.UUID
    part_id: uuid.UUID
    axis: str
    slice_index: int
    method_id: str
    status: str
    cached: bool = False
    regions: List[InspectionSliceSegmentRegion] = Field(default_factory=list)
    selected_region: Optional[InspectionSliceSegmentRegion] = None
    summary: Dict[str, Any] = Field(default_factory=dict)
    warnings: List[str] = Field(default_factory=list)


class InspectionMeasurementInvokeRequest(BaseModel):
    measurement_profile: str = Field(default="default", min_length=1, max_length=64)
    include_overlays: List[str] = Field(default_factory=list)


class InspectionMeasurementInvokeResponse(BaseModel):
    run_id: uuid.UUID
    part_id: uuid.UUID
    status: str
    measurement_profile: str
    units: str
    values: Dict[str, float]
    created_at: datetime


class InspectionWorkspaceStatePayload(BaseModel):
    state: Dict[str, Any] = Field(default_factory=dict)


class InspectionWorkspaceStateResponse(BaseModel):
    project_id: uuid.UUID
    user_email: str
    state: Dict[str, Any] = Field(default_factory=dict)
    updated_at: Optional[datetime] = None


class InspectionAnnotationBase(BaseModel):
    image_id: Optional[str] = Field(default=None, max_length=128)
    defect_class: str = Field(..., min_length=1, max_length=128)
    modality: str = Field(..., min_length=1, max_length=64)
    comment: Optional[str] = Field(default=None, max_length=2000)
    disposition: str = Field(default="open", pattern=r"^(open|accepted|rejected|needs_info)$")
    measurements: Dict[str, float] = Field(default_factory=dict)
    geometry: Optional[Dict[str, Any]] = None
    bbox: Optional[Dict[str, float]] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    hidden: bool = False


class InspectionAnnotationCreate(InspectionAnnotationBase):
    pass


class InspectionAnnotationUpdate(BaseModel):
    image_id: Optional[str] = Field(default=None, max_length=128)
    defect_class: Optional[str] = Field(default=None, min_length=1, max_length=128)
    modality: Optional[str] = Field(default=None, min_length=1, max_length=64)
    comment: Optional[str] = Field(default=None, max_length=2000)
    disposition: Optional[str] = Field(default=None, pattern=r"^(open|accepted|rejected|needs_info)$")
    measurements: Optional[Dict[str, float]] = None
    geometry: Optional[Dict[str, Any]] = None
    bbox: Optional[Dict[str, float]] = None
    metadata: Optional[Dict[str, Any]] = None
    hidden: Optional[bool] = None


class InspectionAnnotation(InspectionAnnotationBase):
    id: uuid.UUID
    created_at: datetime
    created_by: str
    updated_at: datetime
    updated_by: str


class InspectionAnnotationListResponse(BaseModel):
    part_id: uuid.UUID
    annotations: List[InspectionAnnotation]


class InspectionProjectModalityConfig(BaseModel):
    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=128)
    calibration_required: bool = False
    example_image_uploaded: bool = False


class InspectionProjectPartViewConfig(BaseModel):
    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=128)
    required_modalities: List[str] = Field(default_factory=list)
    source: str = Field(default="manual", pattern=r"^(manual|auto)$")


class InspectionProjectDefectTypeConfig(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    color: str = Field(default="#ef4444", min_length=4, max_length=16)
    definition: Optional[str] = Field(default=None, max_length=2000)


class InspectionProjectProcessSettingsConfig(BaseModel):
    require_disposition_on_submit: bool = True
    require_measurement_for_critical: bool = False
    require_second_reviewer_for_reject: bool = False
    configurable_hotkeys: Dict[str, str] = Field(
        default_factory=lambda: {
            "accept_classification": "a",
            "reject_classification": "r",
            "toggle_shortcut_help": "h",
        }
    )

    @field_validator("configurable_hotkeys")
    @classmethod
    def validate_configurable_hotkeys(cls, value: Dict[str, str]) -> Dict[str, str]:
        required_keys = {"accept_classification", "reject_classification", "toggle_shortcut_help"}
        if not required_keys.issubset(value.keys()):
            missing = ", ".join(sorted(required_keys - set(value.keys())))
            raise ValueError(f"configurable_hotkeys missing required keys: {missing}")
        normalized: Dict[str, str] = {}
        for binding, hotkey in value.items():
            if not isinstance(hotkey, str):
                raise ValueError(f"Hotkey for '{binding}' must be a string")
            trimmed = hotkey.strip().lower()
            if len(trimmed) != 1 or not trimmed.isalnum():
                raise ValueError(f"Hotkey for '{binding}' must be a single alphanumeric character")
            normalized[binding] = trimmed
        if len(set(normalized.values())) != len(normalized):
            raise ValueError("configurable_hotkeys must use unique key bindings")
        return normalized


class InspectionProjectDisplaySettingsConfig(BaseModel):
    default_colormap: str = Field(default="grayscale", min_length=1, max_length=64)
    anomaly_colormap: str = Field(default="viridis", min_length=1, max_length=64)
    grayscale_base_image: bool = True


class InspectionProjectPhaseSettingsConfig(BaseModel):
    manual_phase_selection_enabled: bool = False
    manual_phase: str = Field(default="data_ingestion", pattern=r"^(data_ingestion|part_inspection|reporting)$")


class InspectionProjectInterfaceLayoutConfig(BaseModel):
    default_model: Optional[Dict[str, Any]] = None


class InspectionProjectFileNamingEntryConfig(BaseModel):
    id: str = Field(default="other", max_length=128)
    label: str = Field(default="", max_length=255)
    abbreviation: str = Field(default="", max_length=64)


class InspectionProjectFileNamingSchemeConfig(BaseModel):
    use_filename_convention: bool = True
    hierarchy_levels: List[InspectionProjectFileNamingEntryConfig] = Field(default_factory=list)
    image_descriptors: List[InspectionProjectFileNamingEntryConfig] = Field(default_factory=list)


class InspectionProjectOwnerConfig(BaseModel):
    name: str = Field(default="", max_length=255)
    email: str = Field(default="", max_length=255)


class InspectionProjectCurrentUserConfig(BaseModel):
    username: str = Field(default="", max_length=255)
    sso_authenticated: bool = False


class InspectionProjectNsiproParserConfig(BaseModel):
    parser_id: str = Field(default="default", max_length=128)
    parser_version: Optional[str] = Field(default=None, max_length=128)
    parser_hash: Optional[str] = Field(default=None, max_length=255)
    strict_version_match: bool = False


class InspectionProjectMetadataParsersConfig(BaseModel):
    nsipro: InspectionProjectNsiproParserConfig = Field(default_factory=InspectionProjectNsiproParserConfig)


class InspectionProjectConfiguration(BaseModel):
    image_modalities: List[InspectionProjectModalityConfig] = Field(default_factory=list)
    part_views: List[InspectionProjectPartViewConfig] = Field(default_factory=list)
    defect_types: List[InspectionProjectDefectTypeConfig] = Field(default_factory=list)
    process_settings: InspectionProjectProcessSettingsConfig = Field(default_factory=InspectionProjectProcessSettingsConfig)
    display_settings: InspectionProjectDisplaySettingsConfig = Field(default_factory=InspectionProjectDisplaySettingsConfig)
    phase_settings: InspectionProjectPhaseSettingsConfig = Field(default_factory=InspectionProjectPhaseSettingsConfig)
    interface_layout: InspectionProjectInterfaceLayoutConfig = Field(default_factory=InspectionProjectInterfaceLayoutConfig)
    metadata_parsers: InspectionProjectMetadataParsersConfig = Field(default_factory=InspectionProjectMetadataParsersConfig)
    file_naming_scheme: InspectionProjectFileNamingSchemeConfig = Field(default_factory=InspectionProjectFileNamingSchemeConfig)
    project_owner: InspectionProjectOwnerConfig = Field(default_factory=InspectionProjectOwnerConfig)
    current_user: InspectionProjectCurrentUserConfig = Field(default_factory=InspectionProjectCurrentUserConfig)


class InspectionProjectConfigurationPayload(BaseModel):
    config: InspectionProjectConfiguration


class InspectionProjectConfigurationResponse(BaseModel):
    project_id: uuid.UUID
    config: InspectionProjectConfiguration
    updated_at: Optional[datetime] = None


class InspectionProjectConfigurationCloneRequest(BaseModel):
    source_project_id: uuid.UUID


class InspectionProjectConfigurationCloneResponse(BaseModel):
    project_id: uuid.UUID
    source_project_id: uuid.UUID
    config: InspectionProjectConfiguration
    updated_at: Optional[datetime] = None


class InspectionInterfaceLayoutDefaultPayload(BaseModel):
    layout_model: Dict[str, Any]


class InspectionIngestPartRecord(BaseModel):
    serial_number: str = Field(..., min_length=1, max_length=255)
    display_name: Optional[str] = Field(default=None, max_length=255)
    metadata_json: Optional[Dict[str, Any]] = Field(
        default=None,
        validation_alias="metadata",
        serialization_alias="metadata",
    )
    review_state: str = Field(default="unreviewed", pattern=r"^(unreviewed|in_review|pass|reject_pending|reject_confirmed)$")

    @field_validator("serial_number")
    @classmethod
    def strip_serial_number(cls, v: str) -> str:
        return v.strip()


class InspectionIngestBatchRecord(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    parts: List[InspectionIngestPartRecord] = Field(default_factory=list)


class InspectionBulkIngestPayload(BaseModel):
    batches: List[InspectionIngestBatchRecord] = Field(default_factory=list)
    unassigned_parts: List[InspectionIngestPartRecord] = Field(default_factory=list)


class InspectionIngestDiscrepancy(BaseModel):
    code: str
    batch_name: str
    serial_number: Optional[str] = None
    message: str


class InspectionBulkIngestResponse(BaseModel):
    project_id: uuid.UUID
    counters: Dict[str, int]
    discrepancies: List[InspectionIngestDiscrepancy] = Field(default_factory=list)


class InspectionPartImageAssignmentRequest(BaseModel):
    filename: str = Field(..., min_length=1, max_length=1024)
    image_id: Optional[uuid.UUID] = None
    to_part_id: Optional[uuid.UUID] = None


class InspectionPartImageAssignmentResponse(BaseModel):
    project_id: uuid.UUID
    filename: str
    from_part_id: Optional[uuid.UUID] = None
    to_part_id: Optional[uuid.UUID] = None


class InspectionOverlayAssignmentRequest(BaseModel):
    overlay_filename: str = Field(..., min_length=1, max_length=1024)
    overlay_image_id: Optional[uuid.UUID] = None
    base_filename: Optional[str] = Field(default=None, max_length=1024)
    base_image_id: Optional[uuid.UUID] = None


class InspectionOverlayAssignmentResponse(BaseModel):
    project_id: uuid.UUID
    overlay_filename: str
    base_filename: Optional[str] = None
    from_part_id: Optional[uuid.UUID] = None
    to_part_id: Optional[uuid.UUID] = None


# ImageGroup schemas
class ImageGroupBase(BaseModel):
    identifier: str = Field(..., min_length=1, max_length=255)
    display_name: Optional[str] = Field(None, max_length=255)

    @field_validator("identifier")
    @classmethod
    def strip_identifier(cls, v: str) -> str:
        return v.strip()

class ImageGroupCreate(ImageGroupBase):
    project_id: uuid.UUID

class ImageGroupUpdate(BaseModel):
    identifier: Optional[str] = Field(None, min_length=1, max_length=255)
    display_name: Optional[str] = Field(None, max_length=255)

    @field_validator("identifier")
    @classmethod
    def strip_identifier(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if v is not None else v

class ImageGroup(ImageGroupBase):
    id: uuid.UUID
    project_id: uuid.UUID
    created_at: datetime
    updated_at: Optional[datetime] = None
    image_count: Optional[int] = None
    aggregate_review_status: Optional[str] = None  # pass, reject_confirmed, reject_pending, or None (for unreviewed/partially reviewed)

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

class ImageGroupList(BaseModel):
    groups: List["ImageGroup"]
    total: int


# DataInstance schemas
class DataInstanceBase(BaseModel):
    filename: str
    content_type: Optional[str] = None
    size_bytes: Optional[int] = None
    metadata_: Optional[Dict[str, Any]] = Field(None, alias="metadata")

class DataInstanceCreate(DataInstanceBase):
    project_id: uuid.UUID
    object_storage_key: str
    uploaded_by_user_id: str
    uploader_id: Optional[uuid.UUID] = None
    group_id: Optional[uuid.UUID] = None

class DataInstance(DataInstanceBase):
    id: uuid.UUID
    project_id: uuid.UUID
    group_id: Optional[uuid.UUID] = None
    object_storage_key: str
    uploaded_by_user_id: str
    uploader_id: Optional[uuid.UUID] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    # Deletion fields
    deleted_at: Optional[datetime] = None
    deleted_by_user_id: Optional[uuid.UUID] = None
    deletion_reason: Optional[str] = None
    pending_hard_delete_at: Optional[datetime] = None
    hard_deleted_at: Optional[datetime] = None
    hard_deleted_by_user_id: Optional[uuid.UUID] = None
    storage_deleted: bool = False

    @field_validator('metadata_', mode='before')
    @classmethod
    def validate_metadata(cls, v):
        # If it's None, return None
        if v is None:
            return None
        
        # If it's already a dict, return it
        if isinstance(v, dict):
            return v
            
        # If it has a __class__ attribute and it's a MetaData object, return an empty dict
        if hasattr(v, '__class__') and getattr(v, '__class__').__name__ == 'MetaData':
            return {}
            
        # Try to convert to dict if possible
        try:
            if hasattr(v, '_asdict'):
                return v._asdict()
            elif hasattr(v, 'items'):
                return dict(v.items())
            elif isinstance(v, str):
                import json
                try:
                    return json.loads(v)
                except json.JSONDecodeError:
                    return {"value": v}
        except (TypeError, ValueError, AttributeError):
            # Handle any parsing errors by logging and returning default
            logger.warning("Failed to parse JSON value, using default", extra={"value_type": type(v).__name__})
            
        # If all else fails, return an empty dict
        return {}

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }


class DataInstancePage(BaseModel):
    """A stable keyset page of project images."""

    items: List[DataInstance]
    total: int = Field(ge=0)
    next_cursor: Optional[str] = None
    has_more: bool


class BatchImageUploadManifestEntry(BaseModel):
    """One positional file entry in a multipart batch image upload."""

    client_index: int = Field(..., ge=0, strict=True)
    filename: str = Field(..., min_length=1, max_length=255)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    group_identifier: Optional[str] = Field(default=None, max_length=255)

    @field_validator("filename")
    @classmethod
    def validate_batch_filename(cls, value: str) -> str:
        filename = value.strip()
        if not filename or filename in {".", ".."}:
            raise ValueError("filename must not be blank")
        if "/" in filename or "\\" in filename or any(ord(character) < 32 for character in filename):
            raise ValueError("filename must not contain path separators or control characters")
        return filename

    @field_validator("group_identifier")
    @classmethod
    def normalize_batch_group_identifier(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class BatchImageUploadSuccess(BaseModel):
    client_index: int
    image: DataInstance


class BatchImageUploadFailure(BaseModel):
    client_index: int
    filename: str
    code: str
    detail: str


class BatchImageUploadResponse(BaseModel):
    uploaded: List[BatchImageUploadSuccess] = Field(default_factory=list)
    failed: List[BatchImageUploadFailure] = Field(default_factory=list)

# ImageClass schemas
class ImageClassBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None

class ImageClassCreate(ImageClassBase):
    project_id: uuid.UUID

class ImageClass(ImageClassBase):
    id: uuid.UUID
    project_id: uuid.UUID
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

# ImageClassification schemas
class ImageClassificationBase(BaseModel):
    image_id: uuid.UUID
    class_id: uuid.UUID
    
    @field_validator('image_id', 'class_id', mode='before')
    @classmethod
    def validate_uuid(cls, v):
        if isinstance(v, str):
            try:
                return uuid.UUID(v)
            except ValueError:
                raise ValueError(f"Invalid UUID format: {v}")
        return v

class ImageClassificationCreate(ImageClassificationBase):
    created_by_id: Optional[uuid.UUID] = None

class ImageClassification(ImageClassificationBase):
    id: uuid.UUID
    created_by_id: uuid.UUID
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    # Remove the related data that's causing issues
    # image_class: Optional[ImageClass] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

# ImageComment schemas
class ImageCommentBase(BaseModel):
    text: str = Field(..., min_length=1)

class ImageCommentCreate(ImageCommentBase):
    image_id: uuid.UUID
    author_id: Optional[uuid.UUID] = None
    
    @field_validator('image_id', 'author_id', mode='before')
    @classmethod
    def validate_uuid(cls, v):
        if v is None:
            return None
        if isinstance(v, str):
            try:
                return uuid.UUID(v)
            except ValueError:
                raise ValueError(f"Invalid UUID format: {v}")
        return v

class ImageComment(ImageCommentBase):
    id: uuid.UUID
    image_id: uuid.UUID
    author_id: uuid.UUID
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    author: Optional[User] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

# ProjectMetadata schemas
class ProjectMetadataBase(BaseModel):
    key: str = Field(..., min_length=1, max_length=255)
    value: Any = None

class ProjectMetadataCreate(ProjectMetadataBase):
    project_id: uuid.UUID

class ProjectMetadata(ProjectMetadataBase):
    id: uuid.UUID
    project_id: uuid.UUID
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

class PresignedUrlResponse(BaseModel):
    url: str
    object_key: str
    method: str = "GET"

# ApiKey schemas
class ApiKeyBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)

class ApiKeyCreate(ApiKeyBase):
    pass

class ApiKey(ApiKeyBase):
    id: uuid.UUID
    user_id: uuid.UUID
    is_active: bool
    last_used_at: Optional[datetime] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

class ApiKeyCreateResponse(BaseModel):
    api_key: ApiKey
    key: str  # The raw API key (only shown once)


# Deletion / Audit Schemas
class ImageDeletionEvent(BaseModel):
    id: uuid.UUID
    image_id: uuid.UUID
    project_id: uuid.UUID
    actor_user_id: Optional[uuid.UUID] = None
    action: str
    reason: Optional[str] = None
    storage_deleted: bool
    previous_state: Optional[Dict[str, Any]] = None
    at: datetime

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

class ImageDeletionEventList(BaseModel):
    events: List[ImageDeletionEvent]
    total: int


# ----------------- ML Analysis Schemas -----------------
class MLAnnotationBase(BaseModel):
    annotation_type: str = Field(..., min_length=3, max_length=50)
    class_name: Optional[str] = None
    confidence: Optional[float] = Field(None, ge=0, le=1)
    data: Dict[str, Any]
    storage_path: Optional[str] = None
    ordering: Optional[int] = None

class MLAnnotationCreate(MLAnnotationBase):
    pass

class MLAnnotation(MLAnnotationBase):
    id: uuid.UUID
    analysis_id: uuid.UUID
    created_at: datetime

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

class MLAnalysisBase(BaseModel):
    model_name: str = Field(
        ...,
        min_length=2,
        max_length=255,
        pattern=r'^[a-zA-Z0-9_\-]+$',
        description="Model name (alphanumeric, dash, underscore only)"
    )
    model_version: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Model version identifier"
    )
    parameters: Optional[Dict[str, Any]] = None

class MLAnalysisCreate(MLAnalysisBase):
    image_id: uuid.UUID

class MLAnalysis(MLAnalysisBase):
    id: uuid.UUID
    image_id: uuid.UUID
    status: str
    error_message: Optional[str] = None
    provenance: Optional[Dict[str, Any]] = None
    requested_by_id: uuid.UUID
    external_job_id: Optional[str] = None
    priority: int
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    annotations: Optional[List[MLAnnotation]] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

class MLAnalysisList(BaseModel):
    analyses: List[MLAnalysis]
    total: int

class MLAnnotationList(BaseModel):
    annotations: List[MLAnnotation]
    total: int


# ImageReview schemas
VALID_REVIEW_STATUSES = {"pass", "reject_pending", "reject_confirmed"}

class ImageReviewBase(BaseModel):
    status: str = Field(..., description="Review status: pass, reject_pending, reject_confirmed")
    notes: Optional[str] = None

    @field_validator('status')
    @classmethod
    def validate_status(cls, v):
        if v not in VALID_REVIEW_STATUSES:
            raise ValueError(f"status must be one of: {', '.join(sorted(VALID_REVIEW_STATUSES))}")
        return v

class ImageReviewCreate(ImageReviewBase):
    image_id: uuid.UUID
    project_id: uuid.UUID
    reviewer_id: uuid.UUID

class ImageReview(ImageReviewBase):
    id: uuid.UUID
    image_id: uuid.UUID
    project_id: uuid.UUID
    reviewer_id: uuid.UUID
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True,
        "populate_by_name": True
    }

class ImageReviewWithUser(ImageReview):
    reviewer_email: Optional[str] = None

class ImageReviewSummary(BaseModel):
    image_id: uuid.UUID
    status: str  # unreviewed, pass, reject_pending, reject_confirmed
    review_count: int
    latest_review: Optional[ImageReview] = None

class ProjectReviewStatus(BaseModel):
    project_id: uuid.UUID
    total_images: int
    reviewed: int
    unreviewed: int
    passed: int
    reject_pending: int
    reject_confirmed: int
