import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import FilenameMetadataExtractor, { applyOverlayIndicatorMetadata, buildConfiguredFilenameFields, extractValues, isFilenameConventionEnabled, stripConfiguredAbbreviation, stripExtension } from './FilenameMetadataExtractor';
import { getConfiguredNsiproParserId, parseNsiproText } from '../metadata/nsiproParsers';
import { appendFilenameOrdinal, assignDuplicateFilenameAliases } from '../utils/imageIdentity';
import { runImageUploadPlan } from './imageUploadBatches';

const S3_IMPORT_BATCH_SIZE = 100;
const S3_IMPORT_CONCURRENCY = 2;
const S3_PICKER_PAGE_SIZE = 100;
const API_ERROR_DETAIL_MAX_LENGTH = 300;
const UPLOAD_PROGRESS_UPDATE_INTERVAL_MS = 5000;
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB ** 2;
const BYTES_PER_GIB = BYTES_PER_KIB ** 3;

const ASSOCIATED_METADATA_EXTENSIONS = ['.json', '.nsipro'];

export function tagDuplicateFilename(filename = '', occurrence = 0) {
  const safeFilename = String(filename ?? '') || 'upload.bin';
  if (occurrence <= 0) return safeFilename;
  return appendFilenameOrdinal(safeFilename, occurrence);
}

export function buildDuplicateFilenameMap(files = []) {
  const mapped = new Map();
  const entries = files.map((file, index) => ({
    file,
    filename: file?.name || `upload-${index}.bin`,
  }));
  const decorated = assignDuplicateFilenameAliases(entries);
  entries.forEach((entry, index) => {
    mapped.set(entry.file, decorated[index].displayName);
  });
  return mapped;
}


export function getUploadItemSizeBytes(item) {
  return Math.max(0, Number(item?.size) || 0);
}

export function getTotalUploadSizeBytes(items = []) {
  return items.reduce((sum, item) => sum + getUploadItemSizeBytes(item), 0);
}

export function formatUploadSize(bytes = 0) {
  const safeBytes = Math.max(0, Number(bytes) || 0);
  if (safeBytes >= BYTES_PER_GIB) return `${(safeBytes / BYTES_PER_GIB).toFixed(2)} GB`;
  if (safeBytes >= BYTES_PER_MIB) return `${(safeBytes / BYTES_PER_MIB).toFixed(2)} MB`;
  if (safeBytes >= BYTES_PER_KIB) return `${(safeBytes / BYTES_PER_KIB).toFixed(2)} KB`;
  return `${safeBytes} B`;
}

function progressPercent(uploadProgress) {
  if (!uploadProgress) return 0;
  const totalBytes = Math.max(0, Number(uploadProgress.totalBytes) || 0);
  if (totalBytes > 0) {
    return Math.min(100, Math.round((Math.max(0, Number(uploadProgress.loadedBytes) || 0) / totalBytes) * 100));
  }
  const total = Math.max(1, Number(uploadProgress.total) || 0);
  return Math.min(100, Math.round((Math.max(0, Number(uploadProgress.completed) || 0) / total) * 100));
}

function progressLabel(uploadProgress) {
  if (!uploadProgress) return '';
  const totalBytes = Math.max(0, Number(uploadProgress.totalBytes) || 0);
  if (totalBytes > 0) {
    return `${formatUploadSize(uploadProgress.loadedBytes)} / ${formatUploadSize(totalBytes)} uploaded`;
  }
  return `${uploadProgress.completed} / ${uploadProgress.total} uploaded`;
}

function getFileExtension(filename = '') {
  const normalized = String(filename).toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');
  return dotIndex >= 0 ? normalized.slice(dotIndex) : '';
}

function safeMetadataReferenceName(filename = '') {
  return String(filename || 'metadata')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'metadata';
}

function stableStringHash(value = '') {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) + value.charCodeAt(index);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function boundApiErrorDetail(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= API_ERROR_DETAIL_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, API_ERROR_DETAIL_MAX_LENGTH - 3)}...`;
}

function formatApiErrorDetail(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string' || typeof detail === 'number' || typeof detail === 'boolean') {
    return boundApiErrorDetail(detail);
  }
  if (Array.isArray(detail)) {
    return boundApiErrorDetail(detail.map(formatApiErrorDetail).filter(Boolean).join('; '));
  }
  if (typeof detail === 'object') {
    const message = formatApiErrorDetail(
      detail.msg ?? detail.message ?? detail.error ?? detail.reason ?? detail.detail,
    );
    const location = Array.isArray(detail.loc)
      ? detail.loc.filter((part) => part !== null && part !== undefined).join('.')
      : boundApiErrorDetail(detail.loc);
    if (message) return boundApiErrorDetail(location ? `${location}: ${message}` : message);
    try {
      return boundApiErrorDetail(JSON.stringify(detail));
    } catch {
      return '';
    }
  }
  return '';
}

async function readFailedResponseDetail(response) {
  let jsonDetail = '';
  try {
    const payload = await response.json();
    jsonDetail = formatApiErrorDetail(payload?.detail);
  } catch {
    // Fall through to the HTTP response metadata.
  }
  return jsonDetail
    || boundApiErrorDetail(response.statusText)
    || `HTTP ${response.status}`;
}

// Associated .nsipro files are decoded in the frontend before upload ingest so
// users get immediate validation feedback and the ingest payload can include the
// parser id/version/hash contract. The backend remains authoritative: ingest
// dereferences associated_metadata_ref from project metadata, validates parser
// contract fields in strict mode, and normalizes the persisted .nsipro payload.
export function parseAssociatedMetadataText(text, filename = '', options = {}) {
  const extension = getFileExtension(filename);
  if (!ASSOCIATED_METADATA_EXTENSIONS.includes(extension)) {
    throw new Error('Unsupported metadata file type. Choose a .json or .nsipro file.');
  }

  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Metadata file is empty.');
  }

  if (extension === '.json') {
    try {
      return { parser: 'json', metadata: JSON.parse(trimmed) };
    } catch (err) {
      throw new Error('Invalid JSON metadata file.');
    }
  }

  return parseNsiproText(trimmed, filename, options);
}


function isAssociatedMetadataFile(file) {
  return ASSOCIATED_METADATA_EXTENSIONS.includes(getFileExtension(file?.name));
}

function readAssociatedMetadataFileText(file) {
  if (file && typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Unable to read metadata file.'));
    reader.readAsText(file);
  });
}

function buildAssociatedMetadataBundle(file, text, parsedResult) {
  const extension = getFileExtension(file?.name);
  const contentHash = stableStringHash(`${file?.name || ''}\n${text}`);
  const key = `associated_upload_metadata:${safeMetadataReferenceName(file?.name)}:${contentHash}`;
  return {
    key,
    value: {
      kind: 'associated_image_upload_metadata',
      filename: file?.name || 'metadata',
      file_type: extension.replace(/^\./, ''),
      parser: parsedResult.parser,
      parser_id: parsedResult.parser_id,
      requested_parser_id: parsedResult.requested_parser_id,
      parser_version: parsedResult.parser_version,
      parser_hash: parsedResult.parser_hash,
      warnings: Array.isArray(parsedResult.warnings) ? parsedResult.warnings : [],
      source_filename: parsedResult.source_filename || file?.name || 'metadata',
      content_hash: contentHash,
      size_bytes: typeof file?.size === 'number' ? file.size : text.length,
      metadata: parsedResult.metadata,
    },
  };
}



function getRecordNsiproMetadata(recordMetadata) {
  const candidates = [
    recordMetadata?.nsipro_metadata,
    recordMetadata?.nsipro_payload,
    recordMetadata?.associated_metadata?.nsipro_metadata,
    recordMetadata?.associated_metadata?.nsipro_payload,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === 'object') || null;
}

function getAssociatedMetadataFields(recordMetadata) {
  const fields = {};
  if (recordMetadata?.associated_metadata_ref) {
    fields.associated_metadata_ref = recordMetadata.associated_metadata_ref;
  }
  if (recordMetadata?.associated_metadata && typeof recordMetadata.associated_metadata === 'object') {
    fields.associated_metadata = recordMetadata.associated_metadata;
  }
  return fields;
}

function getNsiproIngestMetadata(recordMetadata) {
  const nsiproMetadata = getRecordNsiproMetadata(recordMetadata);
  return nsiproMetadata ? { nsipro_metadata: nsiproMetadata } : {};
}

function buildMetadataWithAssociatedReference(baseMetadata, associatedMetadataReference = null) {
  if (!associatedMetadataReference) return baseMetadata;
  return {
    ...(baseMetadata || {}),
    associated_metadata_ref: associatedMetadataReference.project_metadata_key,
    associated_metadata: associatedMetadataReference,
  };
}

function buildAssociatedMetadataImageReference(bundle) {
  if (!bundle?.key || !bundle?.value) return null;
  return {
    reference_type: 'project_metadata',
    project_metadata_key: bundle.key,
    filename: bundle.value.filename,
    file_type: bundle.value.file_type,
    parser: bundle.value.parser,
    parser_id: bundle.value.parser_id,
    requested_parser_id: bundle.value.requested_parser_id,
    parser_version: bundle.value.parser_version,
    parser_hash: bundle.value.parser_hash,
    source_filename: bundle.value.source_filename || bundle.value.filename,
    content_hash: bundle.value.content_hash,
  };
}

const HIERARCHY_KEYS = [
  'design_number',
  'lot_number',
  'serial_number',
  'side',
  'modality',
  'overlay',
];

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
}

function firstNonEmptyValue(candidate, keys) {
  for (const key of keys) {
    const value = candidate?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}


const RESERVED_INGEST_METADATA_KEYS = new Set([
  'design_number',
  'drawing_number',
  'drawing',
  'design',
  'lot_number',
  'lot',
  'set_number',
  'part_number',
  'part',
  'part_group',
  'batch_number',
  'batch',
  'serial_number',
  'serial',
  'sn',
  'side',
  'side_identifier',
  'view',
  'view_name',
  'modality',
  'image_modality',
  'overlay',
  'overlay_base_filename',
  'base_filename',
  'overlay_base_image_id',
  'base_image_id',
  'associated_metadata_ref',
  'associated_metadata',
  'nsipro_metadata',
  'nsipro_payload',
]);

function getAdditionalFilenameMetadata(candidate) {
  if (!candidate || typeof candidate !== 'object') return {};
  return Object.entries(candidate).reduce((acc, [key, value]) => {
    if (!key || RESERVED_INGEST_METADATA_KEYS.has(key)) return acc;
    if (value === undefined || value === null || value === '') return acc;
    acc[key] = value;
    return acc;
  }, {});
}

function normalizeHierarchyMetadata(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const normalized = {
    ...candidate,
    design_number: String(firstNonEmptyValue(candidate, ['design_number', 'drawing_number', 'drawing', 'design'])).trim(),
    lot_number: String(firstNonEmptyValue(candidate, ['lot_number', 'lot'])).trim(),
    set_number: String(firstNonEmptyValue(candidate, ['set_number', 'part_number', 'part', 'part_group'])).trim(),
    batch_number: String(firstNonEmptyValue(candidate, ['batch_number', 'batch'])).trim(),
    serial_number: String(firstNonEmptyValue(candidate, ['serial_number', 'serial', 'sn'])).trim(),
    side: String(firstNonEmptyValue(candidate, ['side', 'side_identifier', 'view', 'view_name'])).trim().toLowerCase(),
    modality: String(firstNonEmptyValue(candidate, ['modality', 'image_modality'])).trim().toLowerCase(),
    overlay: normalizeBoolean(candidate.overlay),
    overlay_base_filename: String(firstNonEmptyValue(candidate, ['overlay_base_filename', 'base_filename'])).trim(),
    overlay_base_image_id: String(firstNonEmptyValue(candidate, ['overlay_base_image_id', 'base_image_id'])).trim(),
    additional_filename_metadata: getAdditionalFilenameMetadata(candidate),
  };
  const hasRequiredHierarchy = HIERARCHY_KEYS
    .filter((key) => key !== 'overlay')
    .every((key) => normalized[key]);
  if (!hasRequiredHierarchy || (!normalized.set_number && !normalized.batch_number)) return null;
  if (!normalized.set_number) delete normalized.set_number;
  if (!normalized.batch_number) delete normalized.batch_number;
  if (!normalized.overlay_base_filename) delete normalized.overlay_base_filename;
  if (!normalized.overlay_base_image_id) delete normalized.overlay_base_image_id;
  if (Object.keys(normalized.additional_filename_metadata).length === 0) delete normalized.additional_filename_metadata;
  return normalized;
}

export function buildInspectionPartIngestPayload(uploadedRecords) {
  const partsByKey = new Map();
  const volumePartsByKey = new Map();

  uploadedRecords.forEach((record) => {
    const metadata = normalizeHierarchyMetadata(record.metadata);
    if (!metadata) {
      const recordMetadata = record?.metadata && typeof record.metadata === 'object' ? record.metadata : {};
      const volumeStackId = String(recordMetadata.volume_stack_id || '').trim();
      const filename = record.image?.filename || record.filename;
      if (!volumeStackId || !filename) return;
      if (!volumePartsByKey.has(volumeStackId)) {
        volumePartsByKey.set(volumeStackId, {
          batchName: `PT3_${volumeStackId}`,
          batchDescription: `PT3 stack ${volumeStackId}`,
          serialNumber: String(recordMetadata.serial_number || volumeStackId),
          displayName: String(recordMetadata.display_name || `PT3 stack ${volumeStackId}`),
          metadata: {
            source: recordMetadata.source || 'manual-build-it',
            project_type: 'PT3',
            volume_stack_id: volumeStackId,
            ...getAssociatedMetadataFields(recordMetadata),
            ...getNsiproIngestMetadata(recordMetadata),
            source_images: [],
          },
        });
      }
      const volumePart = volumePartsByKey.get(volumeStackId);
      volumePart.metadata.source_images.push({
        filename,
        image_id: record.image?.id || null,
        slice_axis: recordMetadata.slice_axis || null,
        slice_index: typeof recordMetadata.slice_index === 'number' ? recordMetadata.slice_index : null,
        modality: recordMetadata.modality || null,
        overlay: normalizeBoolean(recordMetadata.overlay),
        overlay_base_filename: recordMetadata.overlay_base_filename || null,
        overlay_base_image_id: recordMetadata.overlay_base_image_id || null,
        ...getAssociatedMetadataFields(recordMetadata),
        ...getNsiproIngestMetadata(recordMetadata),
      });
      return;
    }

    const partGroupNumber = metadata.set_number || metadata.batch_number;
    const batchName = metadata.batch_number
      ? [
        metadata.design_number,
        metadata.lot_number,
        metadata.batch_number,
      ].join('_')
      : null;
    const partKey = [
      metadata.design_number,
      metadata.lot_number,
      partGroupNumber,
      metadata.serial_number,
    ].join('_');
    const filename = record.image?.filename || record.filename;
    if (!filename) return;

    const additionalFilenameMetadata = metadata.additional_filename_metadata || {};

    if (!partsByKey.has(partKey)) {
      partsByKey.set(partKey, {
        batchName,
        batchDescription: metadata.batch_number
          ? `Design ${metadata.design_number}, lot ${metadata.lot_number}, batch ${metadata.batch_number}`
          : null,
        serialNumber: metadata.serial_number,
        displayName: `${metadata.design_number} ${metadata.lot_number} ${partGroupNumber} ${metadata.serial_number}`,
        metadata: {
          design_number: metadata.design_number,
          lot_number: metadata.lot_number,
          serial_number: metadata.serial_number,
          configured_views: [],
          modalities: [],
          view_images: {},
          overlay_images: {},
          ...getAssociatedMetadataFields(metadata),
          ...getNsiproIngestMetadata(metadata),
          source_images: [],
          ...(Object.keys(additionalFilenameMetadata).length > 0 ? { filename_identifiers: { ...additionalFilenameMetadata } } : {}),
        },
      });
      if (metadata.set_number) {
        partsByKey.get(partKey).metadata.set_number = metadata.set_number;
      }
      if (metadata.batch_number) {
        partsByKey.get(partKey).metadata.batch_number = metadata.batch_number;
      }
    }

    const part = partsByKey.get(partKey);
    const side = metadata.side;
    const modality = metadata.modality;
    if (!part.metadata.configured_views.includes(side)) {
      part.metadata.configured_views.push(side);
    }
    if (!part.metadata.modalities.includes(modality)) {
      part.metadata.modalities.push(modality);
    }
    part.metadata.source_images.push({
      filename,
      side,
      modality,
      overlay: metadata.overlay,
      image_id: record.image?.id || null,
      overlay_base_filename: metadata.overlay_base_filename || null,
      overlay_base_image_id: metadata.overlay_base_image_id || null,
      ...getAssociatedMetadataFields(metadata),
      ...getNsiproIngestMetadata(metadata),
      ...additionalFilenameMetadata,
    });
    if (metadata.overlay) {
      part.metadata.overlay_images[side] = {
        ...(part.metadata.overlay_images[side] || {}),
        [modality]: filename,
      };
    } else if (!part.metadata.view_images[side]) {
      part.metadata.view_images[side] = filename;
    }
  });

  const batchesByName = new Map();
  const unassignedParts = [];
  [...Array.from(partsByKey.values()), ...Array.from(volumePartsByKey.values())].forEach((part) => {
    if (part.batchName && !batchesByName.has(part.batchName)) {
      batchesByName.set(part.batchName, {
        name: part.batchName,
        description: part.batchDescription,
        parts: [],
      });
    }
    if (Array.isArray(part.metadata.configured_views)) {
      part.metadata.configured_views.sort();
    }
    if (Array.isArray(part.metadata.modalities)) {
      part.metadata.modalities.sort();
    }
    const ingestPart = {
      serial_number: part.serialNumber,
      display_name: part.displayName,
      metadata: part.metadata,
    };
    if (part.batchName) {
      batchesByName.get(part.batchName).parts.push(ingestPart);
    } else {
      unassignedParts.push(ingestPart);
    }
  });

  const batches = Array.from(batchesByName.values()).map((batch) => ({
    ...batch,
    parts: batch.parts.sort((left, right) => left.serial_number.localeCompare(right.serial_number)),
  }));

  return {
    batches,
    unassigned_parts: unassignedParts.sort((left, right) => (
      left.serial_number.localeCompare(right.serial_number)
    )),
  };
}

function buildSavedFilenameExtractorConfig(projectConfiguration) {
  const scheme = projectConfiguration?.file_naming_scheme || {};
  const conventionEnabled = isFilenameConventionEnabled(scheme);
  const extractor = scheme.metadata_extractor || {};
  const mode = extractor.mode === 'advanced' ? 'advanced' : 'simple';
  const pattern = String(extractor.pattern || extractor.delimiter || (conventionEnabled ? scheme.delimiter : '') || '');
  const keys = Array.isArray(extractor.keys) ? extractor.keys.filter(Boolean) : [];
  const configuredFields = buildConfiguredFilenameFields(scheme);
  const isValid = pattern.length === 0 || keys.length > 0;

  return {
    isValid,
    hasPattern: pattern.length > 0,
    keys,
    extractMetadata: (filename) => {
      if (!pattern || keys.length === 0) return null;
      const stem = stripExtension(filename);
      const { values, error } = extractValues(stem, mode, pattern);
      if (error || values.length !== keys.length) return null;
      const obj = {};
      keys.forEach((key, index) => {
        const field = configuredFields[index];
        obj[key] = mode === 'simple' ? stripConfiguredAbbreviation(values[index], field) : values[index];
      });
      return applyOverlayIndicatorMetadata(filename, obj, values, keys, mode, pattern, scheme);
    },
  };
}

function ImageUploader({ projectId, projectType = 'PT1', projectConfiguration = null, onUploadComplete, onProjectMetadataLoaded, setError }) {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploadMetadata, setUploadMetadata] = useState('');
  const [associatedMetadataFile, setAssociatedMetadataFile] = useState(null);
  const [associatedMetadataBundle, setAssociatedMetadataBundle] = useState(null);
  const [associatedMetadataParsing, setAssociatedMetadataParsing] = useState(false);
  const [associatedMetadataSaving, setAssociatedMetadataSaving] = useState(false);
  const [associatedMetadataSaved, setAssociatedMetadataSaved] = useState(null);
  const [associatedMetadataError, setAssociatedMetadataError] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const savedExtractorConfig = useMemo(
    () => buildSavedFilenameExtractorConfig(projectConfiguration),
    [projectConfiguration],
  );
  const [legacyExtractorConfig, setLegacyExtractorConfig] = useState(null);
  const extractorConfig = legacyExtractorConfig || savedExtractorConfig;
  const nsiproParserId = useMemo(
    () => getConfiguredNsiproParserId(projectConfiguration),
    [projectConfiguration],
  );
  const [groupKey, setGroupKey] = useState('');
  const [uploading, setUploading] = useState(false);
  const [loadingTestData, setLoadingTestData] = useState(false);
  const [loadingNistTestData, setLoadingNistTestData] = useState(false);
  const [testDataResult, setTestDataResult] = useState(null);
  const [nistTestDataResult, setNistTestDataResult] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [s3Url, setS3Url] = useState('');
  const [s3Objects, setS3Objects] = useState([]);
  const [selectedS3Keys, setSelectedS3Keys] = useState([]);
  const [confirmedS3Keys, setConfirmedS3Keys] = useState([]);
  const [s3RetryEligibleKeys, setS3RetryEligibleKeys] = useState([]);
  const [s3RetrySelectionMode, setS3RetrySelectionMode] = useState(false);
  const [s3PageIndex, setS3PageIndex] = useState(0);
  const [loadingS3Files, setLoadingS3Files] = useState(false);
  const [importingS3Files, setImportingS3Files] = useState(false);
  const [s3PickerOpen, setS3PickerOpen] = useState(false);
  const [s3ListingTruncated, setS3ListingTruncated] = useState(false);
  const [s3ReconciliationBlock, setS3ReconciliationBlock] = useState(null);
  const [activeDataOperation, setActiveDataOperation] = useState(null);
  const cancelledRef = useRef(false);
  const uploadAbortControllerRef = useRef(null);
  const s3AbortControllerRef = useRef(null);
  const dataOperationRef = useRef(null);
  const activeProjectIdRef = useRef(projectId);
  activeProjectIdRef.current = projectId;
  const associatedMetadataParseGenerationRef = useRef(0);
  const uploadProgressRef = useRef(null);
  const uploadProgressTimerRef = useRef(null);

  const clearUploadProgressTimer = useCallback(() => {
    if (uploadProgressTimerRef.current) {
      clearInterval(uploadProgressTimerRef.current);
      uploadProgressTimerRef.current = null;
    }
  }, []);

  const setUploadProgressSnapshot = useCallback((snapshot, { flush = false } = {}) => {
    uploadProgressRef.current = snapshot;
    if (flush) {
      setUploadProgress(snapshot);
    }
  }, []);

  const beginUploadProgress = useCallback((initialProgress) => {
    clearUploadProgressTimer();
    setUploadProgressSnapshot(initialProgress, { flush: true });
    uploadProgressTimerRef.current = setInterval(() => {
      if (uploadProgressRef.current) {
        setUploadProgress({ ...uploadProgressRef.current });
      }
    }, UPLOAD_PROGRESS_UPDATE_INTERVAL_MS);
  }, [clearUploadProgressTimer, setUploadProgressSnapshot]);

  const finishUploadProgress = useCallback(() => {
    clearUploadProgressTimer();
    uploadProgressRef.current = null;
    setUploadProgress(null);
  }, [clearUploadProgressTimer]);

  const acquireDataOperation = useCallback((kind, { s3 = false } = {}) => {
    if (dataOperationRef.current) return null;
    const token = {
      kind,
      projectId,
      controller: new AbortController(),
    };
    dataOperationRef.current = token;
    if (s3) s3AbortControllerRef.current = token.controller;
    setActiveDataOperation(kind);
    return token;
  }, [projectId]);

  const ownsDataOperation = useCallback((token) => (
    Boolean(token)
    && dataOperationRef.current === token
    && activeProjectIdRef.current === token.projectId
  ), []);

  const isDataOperationCurrent = useCallback((token) => (
    ownsDataOperation(token) && !token.controller.signal.aborted
  ), [ownsDataOperation]);

  const releaseDataOperation = useCallback((token) => {
    if (dataOperationRef.current !== token) return;
    dataOperationRef.current = null;
    if (uploadAbortControllerRef.current === token.controller) uploadAbortControllerRef.current = null;
    if (s3AbortControllerRef.current === token.controller) s3AbortControllerRef.current = null;
    setActiveDataOperation(null);
  }, []);

  useEffect(() => {
    setActiveDataOperation(null);
    setUploading(false);
    setLoadingTestData(false);
    setLoadingNistTestData(false);
    setAssociatedMetadataSaving(false);
    setAssociatedMetadataParsing(false);
    setAssociatedMetadataFile(null);
    setAssociatedMetadataBundle(null);
    setAssociatedMetadataSaved(null);
    setAssociatedMetadataError(null);
    setLoadingS3Files(false);
    setImportingS3Files(false);
    setSelectedFiles([]);
    setUploadMetadata('');
    setTestDataResult(null);
    setNistTestDataResult(null);
    setS3Url('');
    setS3Objects([]);
    setSelectedS3Keys([]);
    setConfirmedS3Keys([]);
    setS3RetryEligibleKeys([]);
    setS3RetrySelectionMode(false);
    setS3PageIndex(0);
    setS3PickerOpen(false);
    setS3ListingTruncated(false);
    setS3ReconciliationBlock(null);
    associatedMetadataParseGenerationRef.current += 1;
    cancelledRef.current = false;
    uploadAbortControllerRef.current = null;
    s3AbortControllerRef.current = null;
    finishUploadProgress();

    return () => {
      const operation = dataOperationRef.current;
      if (operation?.projectId === projectId) {
        operation.controller.abort();
        dataOperationRef.current = null;
      }
      uploadAbortControllerRef.current?.abort();
      s3AbortControllerRef.current?.abort();
      clearUploadProgressTimer();
    };
  }, [clearUploadProgressTimer, finishUploadProgress, projectId]);

  const extractorPreviewFiles = useMemo(() => {
    if (selectedFiles.length > 0) return [selectedFiles[0]];
    const firstS3Object = s3Objects[0];
    return firstS3Object
      ? [{ name: firstS3Object.filename || firstS3Object.key }]
      : [];
  }, [s3Objects, selectedFiles]);
  const selectedS3KeySet = useMemo(() => new Set(selectedS3Keys), [selectedS3Keys]);
  const confirmedS3KeySet = useMemo(() => new Set(confirmedS3Keys), [confirmedS3Keys]);
  const s3RetryEligibleKeySet = useMemo(
    () => new Set(s3RetryEligibleKeys),
    [s3RetryEligibleKeys],
  );
  const globalS3SelectionKeys = useMemo(
    () => s3Objects
      .filter((object) => (
        !confirmedS3KeySet.has(object.key)
        && (!s3RetrySelectionMode || s3RetryEligibleKeySet.has(object.key))
      ))
      .map((object) => object.key),
    [confirmedS3KeySet, s3Objects, s3RetryEligibleKeySet, s3RetrySelectionMode],
  );
  const allGlobalS3SelectionKeysSelected = globalS3SelectionKeys.length > 0
    && globalS3SelectionKeys.every((key) => selectedS3KeySet.has(key));
  const s3PageCount = Math.max(1, Math.ceil(s3Objects.length / S3_PICKER_PAGE_SIZE));
  const activeS3PageIndex = Math.min(s3PageIndex, s3PageCount - 1);
  const s3PageStart = activeS3PageIndex * S3_PICKER_PAGE_SIZE;
  const s3PageEnd = Math.min(s3PageStart + S3_PICKER_PAGE_SIZE, s3Objects.length);
  const visibleS3Objects = useMemo(
    () => s3Objects.slice(s3PageStart, s3PageEnd),
    [s3Objects, s3PageEnd, s3PageStart],
  );
  const dataOperationBusy = activeDataOperation !== null;

  useEffect(() => {
    setS3PageIndex((current) => Math.min(
      current,
      Math.max(0, Math.ceil(s3Objects.length / S3_PICKER_PAGE_SIZE) - 1),
    ));
  }, [s3Objects.length]);

  const notifyUploadComplete = useCallback(async (images, completion) => {
    if (!onUploadComplete) {
      return {
        reconciled: completion?.requiresAuthoritativeReconciliation !== true,
        error: null,
      };
    }
    try {
      const result = await onUploadComplete(images, completion);
      return {
        reconciled: completion?.requiresAuthoritativeReconciliation !== true
          || (result !== false && result?.reconciled !== false),
        error: null,
      };
    } catch (error) {
      return { reconciled: false, error };
    }
  }, [onUploadComplete]);

  const handleExtractorChange = useCallback((config) => {
    setLegacyExtractorConfig(config);
    if (groupKey && config.keys && !config.keys.includes(groupKey)) {
      setGroupKey('');
    }
  }, [groupKey]);

  useEffect(() => {
    if (groupKey && !extractorConfig.keys.includes(groupKey)) {
      setGroupKey('');
    }
  }, [extractorConfig.keys, groupKey]);

  const handleAssociatedMetadataFileChange = async (e) => {
    await applyAssociatedMetadataFile(e.target.files && e.target.files[0]);
  };

  const applyAssociatedMetadataFile = useCallback(async (file) => {
    const requestProjectId = projectId;
    const parseGeneration = associatedMetadataParseGenerationRef.current + 1;
    associatedMetadataParseGenerationRef.current = parseGeneration;
    const isCurrentParse = () => (
      activeProjectIdRef.current === requestProjectId
      && associatedMetadataParseGenerationRef.current === parseGeneration
    );
    setAssociatedMetadataFile(file || null);
    setAssociatedMetadataBundle(null);
    setAssociatedMetadataError(null);
    setAssociatedMetadataSaved(null);
    if (!file) return;

    if (!isAssociatedMetadataFile(file)) {
      setAssociatedMetadataError('Unsupported metadata file type. Choose a .json or .nsipro file.');
      return;
    }

    setAssociatedMetadataParsing(true);
    try {
      const text = await readAssociatedMetadataFileText(file);
      if (!isCurrentParse()) return;
      const parsedResult = parseAssociatedMetadataText(text, file.name, {
        parserId: nsiproParserId,
        projectConfiguration,
        failClosed: true,
      });
      setAssociatedMetadataBundle(buildAssociatedMetadataBundle(file, text, parsedResult));
    } catch (err) {
      if (!isCurrentParse()) return;
      setAssociatedMetadataError(err?.message || 'Unable to parse associated metadata file.');
    } finally {
      if (isCurrentParse()) setAssociatedMetadataParsing(false);
    }
  }, [nsiproParserId, projectConfiguration, projectId]);

  const applySelectedUploadFiles = useCallback(async (files) => {
    const fileList = Array.from(files || []);
    const metadataFile = fileList.find(isAssociatedMetadataFile) || null;
    const uploadFiles = fileList.filter((file) => file !== metadataFile);
    setSelectedFiles(uploadFiles);
    if (metadataFile) {
      await applyAssociatedMetadataFile(metadataFile);
    }
  }, [applyAssociatedMetadataFile]);

  const saveAssociatedMetadataBundle = useCallback(async (signal = undefined) => {
    if (!associatedMetadataFile) return null;
    if (associatedMetadataParsing) {
      throw new Error('Associated metadata file is still being parsed.');
    }
    if (associatedMetadataError || !associatedMetadataBundle) {
      throw new Error(associatedMetadataError || 'Associated metadata file could not be parsed.');
    }

    const response = await fetch(`/api/projects/${projectId}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: associatedMetadataBundle.key,
        value: associatedMetadataBundle.value,
      }),
      signal,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        detail = payload?.detail || detail;
      } catch (parseError) {
        detail = response.statusText || detail;
      }
      throw new Error(detail);
    }
    return buildAssociatedMetadataImageReference(associatedMetadataBundle);
  }, [associatedMetadataBundle, associatedMetadataError, associatedMetadataFile, associatedMetadataParsing, projectId]);


  const handleLoadAssociatedMetadata = async () => {
    if (!associatedMetadataFile) {
      setAssociatedMetadataError('Choose a metadata file before loading metadata.');
      return;
    }
    const operation = acquireDataOperation('metadata');
    if (!operation) return;
    setAssociatedMetadataSaving(true);
    setAssociatedMetadataSaved(null);
    try {
      const reference = await saveAssociatedMetadataBundle(operation.controller.signal);
      if (!isDataOperationCurrent(operation)) return;
      setAssociatedMetadataSaved(reference);
      setError(null);
      if (onProjectMetadataLoaded) {
        await onProjectMetadataLoaded(reference);
        if (!isDataOperationCurrent(operation)) return;
      }
    } catch (err) {
      if (!isDataOperationCurrent(operation)) return;
      const detail = err?.message ? ` ${err.message}` : '';
      setError(`Unable to load metadata file.${detail}`);
    } finally {
      if (isDataOperationCurrent(operation)) setAssociatedMetadataSaving(false);
      releaseDataOperation(operation);
    }
  };

  // Handle file input change
  const handleFileChange = async (e) => {
    if (e.target.files) {
      await applySelectedUploadFiles(e.target.files);
    }
  };

  // Handle drag and drop events
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragOver(false);
    if (dataOperationRef.current) return;
    if (e.dataTransfer.files) {
      await applySelectedUploadFiles(e.dataTransfer.files);
    }
  };

  // Handle file upload
  const handleUpload = async (e) => {
    e.preventDefault();

    if (selectedFiles.length === 0) {
      setError('Please select at least one file to upload.');
      return;
    }

    // Block upload when the extractor configuration is invalid.
    if (!extractorConfig.isValid) {
      setError('Filename metadata extractor has errors. Please fix them before uploading.');
      return;
    }

    // Validate manual metadata JSON if provided
    let manualMetadata = null;
    if (uploadMetadata.trim()) {
      try {
        manualMetadata = JSON.parse(uploadMetadata);
      } catch (err) {
        setError('Invalid JSON format for metadata.');
        return;
      }
    }

    const operation = acquireDataOperation('local_upload');
    if (!operation) return;
    setUploading(true);
    cancelledRef.current = false;
    const uploadController = operation.controller;
    uploadAbortControllerRef.current = uploadController;
    try {
      const total = selectedFiles.length;
      const totalBytes = getTotalUploadSizeBytes(selectedFiles);
      beginUploadProgress({ completed: 0, failed: 0, total, loadedBytes: 0, totalBytes });

      let associatedMetadataReference = null;
      if (associatedMetadataFile) {
        try {
          associatedMetadataReference = await saveAssociatedMetadataBundle(uploadController.signal);
          if (!ownsDataOperation(operation)) return;
          if (onProjectMetadataLoaded) {
            try {
              await onProjectMetadataLoaded(associatedMetadataReference);
              if (!ownsDataOperation(operation)) return;
            } catch (metadataRefreshError) {
              if (!ownsDataOperation(operation)) return;
              console.error('Associated metadata was saved, but the project metadata view could not be refreshed:', metadataRefreshError);
            }
          }
        } catch (err) {
          if (!ownsDataOperation(operation)) return;
          if (cancelledRef.current || uploadController.signal.aborted) {
            await notifyUploadComplete([], {
              source: 'local_upload',
              total,
              confirmedSucceeded: 0,
              confirmedFailed: 0,
              completionUnknown: 0,
              notStarted: total,
              cancelled: true,
              partsMayHaveChanged: false,
              requiresAuthoritativeReconciliation: false,
            });
            if (ownsDataOperation(operation)) {
              setError('Upload cancelled before any images were sent. Project data was refreshed.');
            }
          } else {
            const detail = err?.message ? ` ${err.message}` : '';
            setError(`Unable to associate metadata file.${detail}`);
          }
          return;
        }
      }

      let completed = 0;
      let failed = 0;
      let loadedBytes = 0;
      const uploadItems = selectedFiles.map((file, clientIndex) => {
        const extractedMetadata = extractorConfig.extractMetadata(file.name);
        const mergedMetadata = (extractedMetadata || manualMetadata)
          ? { ...(extractedMetadata || {}), ...(manualMetadata || {}) }
          : null;
        const metadataWithAssociatedReference = buildMetadataWithAssociatedReference(
          mergedMetadata,
          associatedMetadataReference,
        );
        const hierarchyMetadata = normalizeHierarchyMetadata(metadataWithAssociatedReference);
        const metadataForUpload = hierarchyMetadata
          ? { ...metadataWithAssociatedReference, ...hierarchyMetadata }
          : metadataWithAssociatedReference;
        return {
          clientIndex,
          file,
          filename: file.name,
          metadata: metadataForUpload || {},
          groupIdentifier: groupKey && extractedMetadata?.[groupKey]
            ? String(extractedMetadata[groupKey])
            : null,
        };
      });

      const uploadResult = await runImageUploadPlan({
      items: uploadItems,
      projectId,
      signal: uploadController.signal,
      shouldStop: () => cancelledRef.current,
      onItemSettled: (outcome) => {
        if (!ownsDataOperation(operation)) return;
        completed += 1;
        if (!outcome.ok) failed += 1;
        loadedBytes += getUploadItemSizeBytes(outcome.item.file);
        setUploadProgressSnapshot({ completed, failed, total, loadedBytes, totalBytes });
      },
    });
      if (!ownsDataOperation(operation)) return;
      const results = uploadResult.successes.map((outcome) => outcome.image);
    const uploadedRecords = uploadResult.successes.map((outcome) => ({
      image: outcome.image,
      filename: outcome.item.filename,
      metadata: outcome.item.metadata,
    }));
    const uploadWasCancelled = () => (
      uploadResult.cancelled || cancelledRef.current || uploadController.signal.aborted
    );
    const completionUnknown = uploadResult.completionUnknown.length;
    let cancelled = uploadWasCancelled();
    const notStarted = uploadResult.failures.filter((outcome) => (
      outcome.code === 'cancelled_before_start'
    )).length;
    const confirmedFailed = Math.max(0, uploadResult.failures.length - completionUnknown - notStarted);
    const retryableFiles = uploadResult.failures
      .filter((outcome) => outcome.code !== 'completion_unknown')
      .map((outcome) => outcome.item.file);

    let ingestError = null;
    let ingestCompletionUnknown = false;
    const ingestPayload = buildInspectionPartIngestPayload(uploadedRecords);
    const partCount = ingestPayload.batches.reduce((acc, batch) => acc + batch.parts.length, 0)
      + ingestPayload.unassigned_parts.length;
      if (partCount > 0 && !cancelled) {
      try {
        const ingestResponse = await fetch(`/api/projects/${projectId}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ingestPayload),
          signal: uploadController.signal,
        });
        if (!ingestResponse.ok) {
          const error = new Error(`HTTP ${ingestResponse.status}`);
          error.ingestCompletionUnknown = ingestResponse.status >= 500;
          throw error;
        }
      } catch (err) {
        if (!ownsDataOperation(operation)) return;
        ingestError = err;
        ingestCompletionUnknown = err?.ingestCompletionUnknown !== false;
        console.error('Error ingesting uploaded images as inspection parts:', err);
      }
      }
      if (!ownsDataOperation(operation)) return;
      cancelled = uploadWasCancelled();

      let reconciliationResult = { reconciled: true, error: null };
      if (results.length > 0 || cancelled || completionUnknown > 0) {
      // A rejected/aborted request can still have committed on the server. One
      // authoritative refresh reconciles the UI without risking a retry.
      reconciliationResult = await notifyUploadComplete(results, {
        source: 'local_upload',
        total,
        confirmedSucceeded: results.length,
        confirmedFailed,
        completionUnknown,
        notStarted,
        cancelled,
        partsMayHaveChanged: partCount > 0 || completionUnknown > 0 || cancelled || ingestCompletionUnknown,
        ingestFailed: Boolean(ingestError),
        ingestCompletionUnknown,
        requiresAuthoritativeReconciliation: completionUnknown > 0 || cancelled || ingestCompletionUnknown,
      });
        if (!ownsDataOperation(operation)) return;
      }
    const reconciliationMessage = (completionUnknown > 0 || cancelled || ingestCompletionUnknown) && !reconciliationResult.reconciled
      ? ' Authoritative project reconciliation failed; reload the project before acting on uncertain files.'
      : ' Project data was refreshed.';
    const uncertainRetryMessage = completionUnknown > 0
      ? ' Completion-unknown files were removed from the retry selection; audit project data and explicitly reselect them only if retrying is safe.'
      : '';
    if (cancelled) {
      const failedSummary = confirmedFailed > 0 ? `, ${confirmedFailed} failed` : '';
      setError(
        `Upload cancelled: ${results.length} confirmed succeeded, ${completionUnknown} completion unknown, ${notStarted} not started${failedSummary} out of ${total}.${reconciliationMessage}${uncertainRetryMessage}`,
      );
    } else if (completionUnknown > 0) {
      const confirmedFailed = Math.max(0, uploadResult.failures.length - completionUnknown);
      setError(
        `Upload finished with uncertain results: ${results.length} confirmed succeeded, ${completionUnknown} completion unknown, ${confirmedFailed} failed out of ${total}.${reconciliationMessage}${uncertainRetryMessage}`,
      );
    } else if (failed > 0) {
      const locallyRejected = uploadResult.failures.filter((outcome) => (
        outcome.code === 'manifest_item_too_large' || outcome.code === 'invalid_manifest_metadata'
      ));
      const rejectionDetail = locallyRejected.length > 0
        ? ` ${locallyRejected.length} ${locallyRejected.length === 1 ? 'file was' : 'files were'} not sent because upload metadata exceeded a built-in limit or was invalid. First: ${locallyRejected[0].item.filename}: ${locallyRejected[0].detail}.`
        : '';
      setError(`Upload complete: ${results.length} succeeded, ${failed} failed out of ${total}.${rejectionDetail}`);
    } else if (ingestCompletionUnknown) {
      setError(`Images uploaded, but part-ingest completion is unknown.${reconciliationMessage}`);
    } else if (ingestError) {
      setError('Images uploaded, but parts could not be created from filename metadata.');
    } else {
      setError(null);
    }
      setSelectedFiles(retryableFiles);
      if (retryableFiles.length === 0) {
        setUploadMetadata('');
      }
    } finally {
      if (ownsDataOperation(operation)) {
        finishUploadProgress();
        setUploading(false);
      }
      releaseDataOperation(operation);
    }
  };

  const getMergedMetadataForName = useCallback((filename, manualMetadata, associatedMetadataReference = null) => {
    const extractedMetadata = extractorConfig.extractMetadata(filename);
    const mergedMetadata = (extractedMetadata || manualMetadata)
      ? { ...(extractedMetadata || {}), ...(manualMetadata || {}) }
      : null;
    const metadataWithAssociatedReference = buildMetadataWithAssociatedReference(
      mergedMetadata,
      associatedMetadataReference,
    );
    const hierarchyMetadata = normalizeHierarchyMetadata(metadataWithAssociatedReference);
    return hierarchyMetadata
      ? { ...metadataWithAssociatedReference, ...hierarchyMetadata }
      : metadataWithAssociatedReference;
  }, [extractorConfig]);

  const parseManualMetadata = () => {
    if (!uploadMetadata.trim()) return null;
    try {
      return JSON.parse(uploadMetadata);
    } catch (err) {
      setError('Invalid JSON format for metadata.');
      return undefined;
    }
  };

  const handleLoadS3Files = async () => {
    if (!s3Url.trim()) {
      setError('Please specify an S3 URL.');
      return;
    }
    const operation = acquireDataOperation('s3_list', { s3: true });
    if (!operation) return;
    setLoadingS3Files(true);
    setS3Objects([]);
    setSelectedS3Keys([]);
    setConfirmedS3Keys([]);
    setS3RetryEligibleKeys([]);
    setS3RetrySelectionMode(false);
    setS3PageIndex(0);
    setS3PickerOpen(false);
    setS3ListingTruncated(false);
    try {
      const response = await fetch(`/api/projects/${projectId}/s3/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3_url: s3Url.trim() }),
        signal: operation.controller.signal,
      });
      if (!isDataOperationCurrent(operation)) return;
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          detail = payload?.detail || detail;
        } catch (parseError) {
          detail = response.statusText || detail;
        }
        throw new Error(detail);
      }
      const payload = await response.json();
      if (!isDataOperationCurrent(operation)) return;
      const objects = payload.objects || [];
      setS3Objects(objects);
      setSelectedS3Keys(objects.map((object) => object.key));
      setS3ListingTruncated(Boolean(payload.truncated));
      setS3PickerOpen(true);
      setError(objects.length ? null : 'No supported files were found at that S3 URL.');
    } catch (err) {
      if (!isDataOperationCurrent(operation) || err?.name === 'AbortError') return;
      const detail = err?.message ? ` ${err.message}` : '';
      setError(`Failed to load files from S3.${detail}`);
    } finally {
      if (ownsDataOperation(operation)) setLoadingS3Files(false);
      releaseDataOperation(operation);
    }
  };

  const handleToggleS3Key = (key) => {
    if (confirmedS3KeySet.has(key)) return;
    setSelectedS3Keys((current) => {
      const selected = new Set(current);
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      return Array.from(selected);
    });
  };

  const handleToggleAllS3Keys = () => {
    if (globalS3SelectionKeys.length === 0) return;
    setSelectedS3Keys((current) => {
      const selected = new Set(current);
      const clearGlobalSelection = globalS3SelectionKeys.every((key) => selected.has(key));
      globalS3SelectionKeys.forEach((key) => {
        if (clearGlobalSelection) selected.delete(key);
        else selected.add(key);
      });
      confirmedS3Keys.forEach((key) => selected.delete(key));
      return s3Objects
        .filter((object) => selected.has(object.key))
        .map((object) => object.key);
    });
  };

  const handleImportS3Files = async () => {
    if (s3ReconciliationBlock) {
      setError('S3 retry is blocked until the uncertain import is reconciled with the project.');
      return;
    }
    if (selectedS3Keys.length === 0) {
      setError('Please choose at least one S3 file to load.');
      return;
    }
    if (!extractorConfig.isValid) {
      setError('Filename metadata extractor has errors. Please fix them before loading S3 files.');
      return;
    }
    const manualMetadata = parseManualMetadata();
    if (manualMetadata === undefined) return;
    const selectedObjects = s3Objects.filter((object) => selectedS3KeySet.has(object.key));
    if (selectedObjects.length === 0) {
      setError('Selected S3 files are no longer available. Reload the S3 listing and try again.');
      return;
    }
    const selectedS3Url = s3Url.trim();
    const operation = acquireDataOperation('s3_import', { s3: true });
    if (!operation) return;
    setImportingS3Files(true);

    try {
      let associatedMetadataReference = null;
      if (associatedMetadataFile) {
        try {
          associatedMetadataReference = await saveAssociatedMetadataBundle(operation.controller.signal);
          if (!isDataOperationCurrent(operation)) return;
          if (onProjectMetadataLoaded) {
            try {
              await onProjectMetadataLoaded(associatedMetadataReference);
              if (!isDataOperationCurrent(operation)) return;
            } catch (metadataRefreshError) {
              if (!isDataOperationCurrent(operation)) return;
              console.error('Associated metadata was saved, but the project metadata view could not be refreshed:', metadataRefreshError);
            }
          }
        } catch (err) {
          if (!isDataOperationCurrent(operation)) return;
          const detail = err?.message ? ` ${err.message}` : '';
          setError(`Unable to associate metadata file.${detail}`);
          return;
        }
      }

      const totalBytes = getTotalUploadSizeBytes(selectedObjects);
      beginUploadProgress({ completed: 0, failed: 0, total: selectedObjects.length, loadedBytes: 0, totalBytes });
      const perFileMetadata = {};
      const groupIdentifiers = {};
      selectedObjects.forEach((object) => {
        const metadataForUpload = getMergedMetadataForName(
          object.filename,
          manualMetadata,
          associatedMetadataReference,
        );
        if (metadataForUpload) {
          perFileMetadata[object.key] = metadataForUpload;
        }
        const extractedMetadata = extractorConfig.extractMetadata(object.filename);
        if (groupKey && extractedMetadata && extractedMetadata[groupKey]) {
          groupIdentifiers[object.key] = extractedMetadata[groupKey];
        }
      });

      const importChunks = [];
      for (let index = 0; index < selectedObjects.length; index += S3_IMPORT_BATCH_SIZE) {
        importChunks.push(selectedObjects.slice(index, index + S3_IMPORT_BATCH_SIZE));
      }

      const importedByKey = new Map();
      const failedByKey = new Map();
      const completionUnknownByKey = new Map();
      let completed = 0;
      let failedCount = 0;
      let loadedBytes = 0;

      const settleChunk = (
        chunk,
        payload = null,
        { requestError = null, completionUnknown = false, acceptedResponse = false } = {},
      ) => {
        const chunkKeys = new Set(chunk.map((object) => object.key));
        const responseRecordsByKey = new Map();
        const ambiguityReasonsByKey = new Map();
        const importedItems = Array.isArray(payload?.imported) ? payload.imported : [];
        const failedItems = Array.isArray(payload?.failed) ? payload.failed : [];

        const explicitValues = (candidates) => {
          const values = [];
          let present = false;
          candidates.forEach(([record, field]) => {
            if (record && Object.prototype.hasOwnProperty.call(record, field)) {
              present = true;
              values.push(record[field]);
            }
          });
          return { present, values };
        };
        const addResponseRecord = (key, record) => {
          const records = responseRecordsByKey.get(key) || [];
          responseRecordsByKey.set(key, [...records, record]);
        };
        const markAmbiguous = (keys, reason) => {
          keys.forEach((key) => {
            if (chunkKeys.has(key) && !ambiguityReasonsByKey.has(key)) {
              ambiguityReasonsByKey.set(key, reason);
            }
          });
        };
        const correlateExplicitRecord = (candidates, outcome) => {
          const explicit = explicitValues(candidates);
          if (!explicit.present) return false;

          const requestedKeys = Array.from(new Set(
            explicit.values.filter((value) => chunkKeys.has(value)),
          ));
          const hasOneUnambiguousRequestedKey = requestedKeys.length === 1
            && explicit.values.length > 0
            && explicit.values.every((value) => value === requestedKeys[0]);
          if (hasOneUnambiguousRequestedKey) {
            addResponseRecord(requestedKeys[0], outcome);
          } else if (requestedKeys.length > 0) {
            markAmbiguous(
              requestedKeys,
              'S3 import response contained conflicting explicit source keys for this file',
            );
          }
          // An explicit foreign, empty, or conflicting key must never fall back
          // to filename correlation.
          return true;
        };

        const importedWithoutSourceKey = [];
        importedItems.forEach((image) => {
          const explicitlyCorrelated = correlateExplicitRecord(
            [
              [image?.metadata, 'source_s3_key'],
              [image, 'source_s3_key'],
            ],
            { type: 'imported', image },
          );
          if (!explicitlyCorrelated) importedWithoutSourceKey.push(image);
        });

        importedWithoutSourceKey.forEach((image) => {
          const filenameMatches = chunk.filter((object) => (
            object.filename === image?.filename
          ));
          if (filenameMatches.length === 1) {
            const key = filenameMatches[0].key;
            addResponseRecord(key, { type: 'imported', image });
          } else if (filenameMatches.length > 1) {
            markAmbiguous(
              filenameMatches.map((object) => object.key),
              'S3 import response could not be correlated because duplicate filenames lacked source keys',
            );
          }
        });

        failedItems.forEach((failure) => {
          const error = formatApiErrorDetail(failure?.error ?? failure?.detail)
            || 'S3 file could not be imported';
          correlateExplicitRecord(
            [
              [failure, 'key'],
              [failure, 'source_s3_key'],
            ],
            { type: 'failed', error },
          );
        });

        chunk.forEach((object) => {
          const { key } = object;
          const records = responseRecordsByKey.get(key) || [];
          const ambiguityReason = ambiguityReasonsByKey.get(key);
          if (ambiguityReason || records.length > 1) {
            completionUnknownByKey.set(key, {
              key,
              error: ambiguityReason
                || 'S3 import response contained duplicate or conflicting results for this file',
            });
            return;
          }
          if (records.length === 1) {
            const [record] = records;
            if (record.type === 'imported') {
              importedByKey.set(key, record.image);
            } else {
              failedByKey.set(key, { key, error: record.error });
            }
            return;
          }

          const omittedFromAcceptedResponse = acceptedResponse && !requestError;
          const outcome = {
            key,
            error: requestError
              || (omittedFromAcceptedResponse
                ? 'S3 import success response omitted this file; server completion is unknown'
                : 'S3 import response did not include a result for this file'),
          };
          if (completionUnknown || omittedFromAcceptedResponse) {
            completionUnknownByKey.set(key, outcome);
          } else {
            failedByKey.set(key, outcome);
          }
        });

        completed += chunk.length;
        failedCount += chunk.filter((object) => (
          failedByKey.has(object.key) || completionUnknownByKey.has(object.key)
        )).length;
        loadedBytes += getTotalUploadSizeBytes(chunk);
        if (ownsDataOperation(operation)) {
          setUploadProgressSnapshot({
            completed,
            failed: failedCount,
            total: selectedObjects.length,
            loadedBytes,
            totalBytes,
          });
        }
      };

      let nextChunkIndex = 0;
      const importWorker = async () => {
        while (isDataOperationCurrent(operation)) {
          const chunkIndex = nextChunkIndex;
          nextChunkIndex += 1;
          if (chunkIndex >= importChunks.length) return;
          const chunk = importChunks[chunkIndex];
          const keys = chunk.map((object) => object.key);
          try {
            const response = await fetch(`/api/projects/${projectId}/s3/import`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                s3_url: selectedS3Url,
                keys,
                per_file_metadata: Object.fromEntries(
                  keys.filter((key) => perFileMetadata[key]).map((key) => [key, perFileMetadata[key]]),
                ),
                group_identifiers: Object.fromEntries(
                  keys.filter((key) => groupIdentifiers[key]).map((key) => [key, groupIdentifiers[key]]),
                ),
              }),
              signal: operation.controller.signal,
            });
            if (!isDataOperationCurrent(operation)) return;
            if (!response.ok) {
              const detail = await readFailedResponseDetail(response);
              const status = Number(response.status);
              const definiteRejection = status >= 400 && status < 500;
              settleChunk(chunk, null, {
                requestError: definiteRejection
                  ? detail
                  : `${detail}; server completion is unknown`,
                completionUnknown: !definiteRejection,
              });
              continue;
            }
            let payload;
            try {
              payload = await response.json();
            } catch (parseError) {
              settleChunk(chunk, null, {
                requestError: 'S3 import response was not valid JSON; server completion is unknown',
                completionUnknown: true,
              });
              continue;
            }
            settleChunk(chunk, payload, { acceptedResponse: true });
          } catch (err) {
            if (!isDataOperationCurrent(operation) || err?.name === 'AbortError') return;
            const requestDetail = err?.message || 'S3 import request failed';
            settleChunk(chunk, null, {
              requestError: `${requestDetail}; server completion is unknown`,
              completionUnknown: true,
            });
          }
        }
      };

      await Promise.all(Array.from(
        { length: Math.min(S3_IMPORT_CONCURRENCY, importChunks.length) },
        () => importWorker(),
      ));
      if (!isDataOperationCurrent(operation)) return;

      const imported = selectedObjects
        .map((object) => importedByKey.get(object.key))
        .filter(Boolean);
      const failed = selectedObjects
        .map((object) => failedByKey.get(object.key))
        .filter(Boolean);
      const completionUnknown = selectedObjects
        .map((object) => completionUnknownByKey.get(object.key))
        .filter(Boolean);
      const retryableS3Keys = failed.map((outcome) => outcome.key);
      const importedS3Keys = selectedObjects
        .filter((object) => importedByKey.has(object.key))
        .map((object) => object.key);
      const nextConfirmedS3KeySet = new Set(confirmedS3Keys);
      importedS3Keys.forEach((key) => nextConfirmedS3KeySet.add(key));
      const nextConfirmedS3Keys = s3Objects
        .filter((object) => nextConfirmedS3KeySet.has(object.key))
        .map((object) => object.key);
      const attemptedS3KeySet = new Set(selectedObjects.map((object) => object.key));
      const nextRetryEligibleS3KeySet = new Set(s3RetryEligibleKeys);
      attemptedS3KeySet.forEach((key) => nextRetryEligibleS3KeySet.delete(key));
      retryableS3Keys.forEach((key) => nextRetryEligibleS3KeySet.add(key));
      nextConfirmedS3Keys.forEach((key) => nextRetryEligibleS3KeySet.delete(key));
      const nextRetryEligibleS3Keys = s3Objects
        .filter((object) => nextRetryEligibleS3KeySet.has(object.key))
        .map((object) => object.key);
      setConfirmedS3Keys(nextConfirmedS3Keys);
      setS3RetryEligibleKeys(nextRetryEligibleS3Keys);
      setS3RetrySelectionMode(true);
      setSelectedS3Keys(retryableS3Keys);
      if (retryableS3Keys.length > 0) {
        const firstFailureIndex = s3Objects.findIndex(
          (object) => object.key === retryableS3Keys[0],
        );
        if (firstFailureIndex >= 0) {
          setS3PageIndex(Math.floor(firstFailureIndex / S3_PICKER_PAGE_SIZE));
        }
      }
      setUploadProgressSnapshot({
        completed: selectedObjects.length,
        failed: failed.length + completionUnknown.length,
        total: selectedObjects.length,
        loadedBytes: totalBytes,
        totalBytes,
      }, { flush: true });

      let ingestError = null;
      let ingestCompletionUnknown = false;
      const uploadedRecords = selectedObjects
        .map((object) => {
          const image = importedByKey.get(object.key);
          if (!image) return null;
          return {
            image,
            filename: object.filename,
            metadata: perFileMetadata[object.key] || {},
          };
        })
        .filter(Boolean);
      const ingestPayload = buildInspectionPartIngestPayload(uploadedRecords);
      const partCount = ingestPayload.batches.reduce((acc, batch) => acc + batch.parts.length, 0)
        + ingestPayload.unassigned_parts.length;
      if (partCount > 0) {
        try {
          const ingestResponse = await fetch(`/api/projects/${projectId}/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ingestPayload),
            signal: operation.controller.signal,
          });
          if (!ingestResponse.ok) {
            const error = new Error(await readFailedResponseDetail(ingestResponse));
            const status = Number(ingestResponse.status);
            error.ingestCompletionUnknown = !(status >= 400 && status < 500);
            throw error;
          }
        } catch (err) {
          if (!isDataOperationCurrent(operation)) return;
          ingestError = err;
          ingestCompletionUnknown = err?.ingestCompletionUnknown !== false;
          console.error('Error ingesting S3-loaded images as inspection parts:', err);
        }
      }

      const completion = {
        source: 's3_import',
        total: selectedObjects.length,
        confirmedSucceeded: imported.length,
        confirmedFailed: failed.length,
        completionUnknown: completionUnknown.length,
        notStarted: 0,
        cancelled: false,
        partsMayHaveChanged: partCount > 0 || completionUnknown.length > 0 || ingestCompletionUnknown,
        ingestFailed: Boolean(ingestError),
        ingestCompletionUnknown,
        requiresAuthoritativeReconciliation: completionUnknown.length > 0 || ingestCompletionUnknown,
      };
      // A 5xx, transport failure, or unreadable success response can happen
      // after the server commits. Refresh once instead of retrying and
      // risking duplicate project images.
      const reconciliationResult = await notifyUploadComplete(imported, completion);
      if (!isDataOperationCurrent(operation)) return;
      const ingestErrorDetail = boundApiErrorDetail(ingestError?.message) || 'request failed after dispatch';
      const committedImageSummary = `S3 image import complete: ${imported.length} loaded and committed, ${failed.length} failed out of ${selectedObjects.length}.`;
      const firstConfirmedFailureReason = Array.from(new Set(
        failed
          .map((outcome) => formatApiErrorDetail(outcome.error))
          .filter(Boolean),
      ))[0] || '';
      const confirmedFailureDetail = firstConfirmedFailureReason
        ? ` First confirmed failure: ${firstConfirmedFailureReason}.`
        : '';
      if (completionUnknown.length > 0) {
        const ingestDetail = ingestError
          ? (ingestCompletionUnknown
            ? ` Confirmed image imports are committed; part creation completion is uncertain: ${ingestErrorDetail}.`
            : ` Confirmed image imports are committed, but part creation failed: ${ingestErrorDetail}.`)
          : '';
        const retryDetail = ' Confirmed successes and completion-unknown files were removed from the retry selection; completion-unknown files require manual audit and explicit reselection.';
        if (reconciliationResult.reconciled) {
          setS3ReconciliationBlock(null);
          setError(
            `S3 load finished with uncertain results: ${imported.length} confirmed succeeded, ${completionUnknown.length} completion unknown, ${failed.length} failed out of ${selectedObjects.length}.${confirmedFailureDetail} Project data was refreshed.${retryDetail}${ingestDetail}`,
          );
        } else {
          setS3ReconciliationBlock({ completion });
          setError(
            `S3 load finished with uncertain results: ${imported.length} confirmed succeeded, ${completionUnknown.length} completion unknown, ${failed.length} failed out of ${selectedObjects.length}.${confirmedFailureDetail} Authoritative project reconciliation failed, so S3 retry is blocked until reconciliation succeeds.${retryDetail}${ingestDetail}`,
          );
        }
      } else if (ingestCompletionUnknown) {
        setS3ReconciliationBlock(null);
        setError(reconciliationResult.reconciled
          ? `${committedImageSummary} Part creation completion is uncertain: ${ingestErrorDetail}. Project data was authoritatively reconciled.`
          : `${committedImageSummary} Part creation completion is uncertain: ${ingestErrorDetail}. Authoritative project reconciliation failed.`);
      } else if (failed.length > 0) {
        setS3ReconciliationBlock(null);
        const ingestDetail = ingestError
          ? ` Imported images are committed, but part creation failed: ${ingestErrorDetail}.`
          : '';
        setError(`S3 load complete: ${imported.length} succeeded, ${failed.length} failed out of ${selectedObjects.length}.${confirmedFailureDetail}${ingestDetail}`);
      } else if (ingestError) {
        setS3ReconciliationBlock(null);
        setError(`${committedImageSummary} Part creation failed: ${ingestErrorDetail}.`);
      } else {
        setS3ReconciliationBlock(null);
        setError(null);
      }
      if (completionUnknown.length === 0 && nextRetryEligibleS3Keys.length === 0) {
        setS3PickerOpen(false);
      }
    } catch (err) {
      if (!isDataOperationCurrent(operation) || err?.name === 'AbortError') return;
      const detail = err?.message ? ` ${err.message}` : '';
      setError(`Failed to import selected S3 files.${detail}`);
    } finally {
      if (ownsDataOperation(operation)) {
        setImportingS3Files(false);
        finishUploadProgress();
      }
      releaseDataOperation(operation);
    }
  };

  const handleRetryS3Reconciliation = async () => {
    if (!s3ReconciliationBlock) return;
    const operation = acquireDataOperation('s3_reconcile', { s3: true });
    if (!operation) return;
    setImportingS3Files(true);
    try {
      const result = await notifyUploadComplete([], {
        ...s3ReconciliationBlock.completion,
        retryReconciliation: true,
      });
      if (!isDataOperationCurrent(operation)) return;
      if (result.reconciled) {
        setS3ReconciliationBlock(null);
        setError('Project reconciliation succeeded. Completion-unknown S3 files remain unselected; audit project data and explicitly reselect a file only if retrying is safe.');
      } else {
        setError('Authoritative project reconciliation still failed. S3 retry remains blocked.');
      }
    } finally {
      if (ownsDataOperation(operation)) setImportingS3Files(false);
      releaseDataOperation(operation);
    }
  };

  const handleLoadTestData = async () => {
    const operation = acquireDataOperation('test_data');
    if (!operation) return;
    setLoadingTestData(true);
    setTestDataResult(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/load-test-data`, {
        method: 'POST',
        signal: operation.controller.signal,
      });
      if (!isDataOperationCurrent(operation)) return;
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          detail = payload?.detail || detail;
        } catch (parseError) {
          detail = response.statusText || detail;
        }
        throw new Error(detail);
      }
      const payload = await response.json();
      if (!isDataOperationCurrent(operation)) return;
      setTestDataResult(payload);
      setError(null);
      if (onUploadComplete) {
        await onUploadComplete(payload, {
          source: 'test_data',
          total: Number(payload?.images_created) || 0,
          confirmedSucceeded: Number(payload?.images_created) || 0,
          confirmedFailed: 0,
          completionUnknown: 0,
          notStarted: 0,
          cancelled: false,
          partsMayHaveChanged: true,
          requiresAuthoritativeReconciliation: false,
          payload,
        });
        if (!isDataOperationCurrent(operation)) return;
      }
    } catch (err) {
      if (!isDataOperationCurrent(operation) || err?.name === 'AbortError') return;
      const detail = err?.message ? ` ${err.message}` : '';
      setError(`Failed to load ${projectType || 'project'} test data.${detail}`);
    } finally {
      if (ownsDataOperation(operation)) setLoadingTestData(false);
      releaseDataOperation(operation);
    }
  };

  const handleLoadNistTestData = async () => {
    const operation = acquireDataOperation('nist_test_data');
    if (!operation) return;
    setLoadingNistTestData(true);
    setNistTestDataResult(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/load-test-data?fixture=nist-cocr`, {
        method: 'POST',
        signal: operation.controller.signal,
      });
      if (!isDataOperationCurrent(operation)) return;
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          detail = payload?.detail || detail;
        } catch (parseError) {
          detail = response.statusText || detail;
        }
        throw new Error(detail);
      }
      const payload = await response.json();
      if (!isDataOperationCurrent(operation)) return;
      setNistTestDataResult(payload);
      setError(null);
      if (onUploadComplete) {
        await onUploadComplete(payload, {
          source: 'test_data',
          fixture: 'nist-cocr',
          total: Number(payload?.images_created) || 0,
          confirmedSucceeded: Number(payload?.images_created) || 0,
          confirmedFailed: 0,
          completionUnknown: 0,
          notStarted: 0,
          cancelled: false,
          partsMayHaveChanged: true,
          requiresAuthoritativeReconciliation: true,
          payload,
        });
        if (!isDataOperationCurrent(operation)) return;
      }
    } catch (err) {
      if (!isDataOperationCurrent(operation) || err?.name === 'AbortError') return;
      const detail = err?.message ? ` ${err.message}` : '';
      setError(`Failed to load NIST CoCr volume.${detail}`);
    } finally {
      if (ownsDataOperation(operation)) setLoadingNistTestData(false);
      releaseDataOperation(operation);
    }
  };

  const selectedFilesTotalBytes = getTotalUploadSizeBytes(selectedFiles);
  const selectedS3TotalBytes = getTotalUploadSizeBytes(
    s3Objects.filter((object) => selectedS3KeySet.has(object.key))
  );

  return (
    <div className="card">
      <div className="card-header">
        <h2>Upload Images</h2>
      </div>
      <div className="card-content">
        <form onSubmit={handleUpload}>
          <div
            className={`upload-area ${isDragOver ? 'drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => {
              if (!dataOperationBusy) document.getElementById('file-input').click();
            }}
          >
            <div className="upload-area-content">
              <div className="upload-area-icon">
                +
              </div>
              <div className="upload-area-text">
                Drag and drop images/voxel data here, or click to select files
              </div>
              <div className="upload-area-subtext">
                Supports image files, 3D voxel arrays (.npy, .npz, .inspiro), and one associated .nsipro/.json metadata file
              </div>
              <div className={`upload-area-status ${selectedFiles.length > 0 ? 'has-files' : 'no-files'}`}>
                {selectedFiles.length > 0
                  ? `${selectedFiles.length} ${selectedFiles.length === 1 ? 'file' : 'files'} selected (${formatUploadSize(selectedFilesTotalBytes)})`
                  : 'No files selected'}
              </div>
            </div>
            <input
              type="file"
              id="file-input"
              accept="image/*,image/tiff,.tiff,.tif,.npy,.npz,.inspiro,.json,.nsipro,application/json"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
              disabled={dataOperationBusy}
            />
          </div>

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label htmlFor="s3-url-input">S3 URL (Optional)</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                id="s3-url-input"
                type="text"
                className="form-control"
                placeholder="s3://bucket/path/to/files/"
                value={s3Url}
                onChange={(e) => setS3Url(e.target.value)}
                disabled={dataOperationBusy || Boolean(s3ReconciliationBlock)}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleLoadS3Files}
                disabled={dataOperationBusy || Boolean(s3ReconciliationBlock)}
              >
                {loadingS3Files ? 'Loading S3 Files...' : 'Load Files from S3'}
              </button>
            </div>
            <small className="form-text">
              Enter an s3:// bucket or prefix, then choose which files to load into this project.
            </small>
          </div>

          {s3ReconciliationBlock && (
            <div className="alert alert-warning" role="alert">
              An uncertain S3 import has not been reconciled. Loading selected S3 files again is blocked to prevent duplicates.
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginLeft: '8px' }}
                onClick={handleRetryS3Reconciliation}
                disabled={dataOperationBusy}
              >
                {importingS3Files ? 'Retrying Project Reconciliation...' : 'Retry Project Reconciliation'}
              </button>
            </div>
          )}

          {s3PickerOpen && (
            <div
              className="card"
              style={{
                margin: '12px 0',
                border: '1px solid #dee2e6',
                boxSizing: 'border-box',
                maxWidth: '100%',
                minWidth: 0,
              }}
              data-testid="s3-file-picker"
            >
              <div className="card-header">
                <h3 style={{ margin: 0 }}>Choose S3 Files</h3>
              </div>
              <div className="card-content">
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '8px',
                  minWidth: 0,
                }}>
                  <span>{selectedS3Keys.length} / {s3Objects.length} selected ({formatUploadSize(selectedS3TotalBytes)})</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleToggleAllS3Keys}
                    disabled={dataOperationBusy || globalS3SelectionKeys.length === 0}
                  >
                    {s3RetrySelectionMode
                      ? (allGlobalS3SelectionKeysSelected
                        ? 'Clear Retryable Failures'
                        : 'Select Retryable Failures')
                      : (allGlobalS3SelectionKeysSelected ? 'Clear Selection' : 'Select All')}
                  </button>
                </div>
                {s3ListingTruncated && (
                  <div className="alert alert-warning" role="status" style={{ marginBottom: '8px' }}>
                    The S3 listing was truncated by the server. All returned files are selectable; narrow the S3 prefix to load additional files.
                  </div>
                )}
                <div
                  id="s3-object-list"
                  style={{
                    maxHeight: '240px',
                    overflowX: 'hidden',
                    overflowY: 'auto',
                    border: '1px solid #e9ecef',
                    borderRadius: '4px',
                    minWidth: 0,
                  }}
                >
                  {visibleS3Objects.map((object) => (
                    <label
                      key={object.key}
                      data-testid="s3-object-row"
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center',
                        padding: '8px',
                        borderBottom: '1px solid #f1f3f5',
                        minWidth: 0,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedS3KeySet.has(object.key)}
                        onChange={() => handleToggleS3Key(object.key)}
                        disabled={dataOperationBusy || confirmedS3KeySet.has(object.key)}
                      />
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                        <strong style={{ overflowWrap: 'anywhere' }}>{object.filename}</strong>
                        <br />
                        <small style={{ overflowWrap: 'anywhere' }}>
                          {object.key} · {formatUploadSize(object.size)}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
                <nav
                  aria-label="S3 object pages"
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                    marginTop: '8px',
                    minWidth: 0,
                  }}
                >
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-controls="s3-object-list"
                    onClick={() => setS3PageIndex((current) => Math.max(0, current - 1))}
                    disabled={dataOperationBusy || activeS3PageIndex === 0}
                  >
                    Previous
                  </button>
                  <span
                    role="status"
                    aria-live="polite"
                    data-testid="s3-pagination-status"
                    style={{ flex: '1 1 180px', minWidth: 0, overflowWrap: 'anywhere', textAlign: 'center' }}
                  >
                    Page {activeS3PageIndex + 1} of {s3PageCount}
                    {' · '}
                    Showing {s3Objects.length === 0 ? 0 : s3PageStart + 1}-{s3PageEnd} of {s3Objects.length} objects
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-controls="s3-object-list"
                    onClick={() => setS3PageIndex((current) => Math.min(s3PageCount - 1, current + 1))}
                    disabled={dataOperationBusy || activeS3PageIndex >= s3PageCount - 1}
                  >
                    Next
                  </button>
                </nav>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={handleImportS3Files}
                    disabled={dataOperationBusy || Boolean(s3ReconciliationBlock) || selectedS3Keys.length === 0 || !extractorConfig.isValid}
                  >
                    {importingS3Files ? 'Loading Selected S3 Files...' : 'Load Selected S3 Files'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setS3PickerOpen(false)}
                    disabled={dataOperationBusy}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}


          <div className="filename-decoder-utility">
            <FilenameMetadataExtractor
              files={extractorPreviewFiles}
              onConfigChange={handleExtractorChange}
              fileNamingScheme={projectConfiguration?.file_naming_scheme}
              initialConfig={projectConfiguration?.file_naming_scheme?.metadata_extractor || {
                mode: 'simple',
                pattern: isFilenameConventionEnabled(projectConfiguration?.file_naming_scheme)
                  ? (projectConfiguration?.file_naming_scheme?.delimiter || (projectConfiguration?.file_naming_scheme ? '' : '_'))
                  : '',
                keys: [],
              }}
              title="Filename Regex & Delimiter Decoder"
            />
          </div>

          {extractorConfig.keys && extractorConfig.keys.length > 0 && (
            <div className="form-group">
              <label htmlFor="group-key-select">Use as Group Identifier (Optional)</label>
              <select
                id="group-key-select"
                value={groupKey}
                onChange={(e) => setGroupKey(e.target.value)}
                className="form-control"
              >
                <option value="">-- None --</option>
                {extractorConfig.keys.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
              <small className="form-text">
                Select which extracted key to use as the group identifier for each uploaded image.
              </small>
            </div>
          )}

          <div className="form-group">
            <fieldset className="metadata-association-section" style={{ border: '1px solid #e9ecef', borderRadius: '4px', padding: '12px' }}>
              <legend style={{ fontSize: '1rem', fontWeight: 600, padding: '0 4px' }}>Associate Metadata</legend>
              <label htmlFor="associated-metadata-input">Metadata File (Optional)</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  id="associated-metadata-input"
                  type="file"
                  accept=".json,.nsipro,application/json"
                  onChange={handleAssociatedMetadataFileChange}
                  disabled={dataOperationBusy}
                />
                <span className="form-text" aria-live="polite">
                  {associatedMetadataFile ? associatedMetadataFile.name : 'No metadata file chosen'}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleLoadAssociatedMetadata}
                  disabled={dataOperationBusy || associatedMetadataParsing || !associatedMetadataBundle || Boolean(associatedMetadataError)}
                >
                  {associatedMetadataSaving ? 'Loading Metadata...' : 'Load Metadata'}
                </button>
              </div>
              <small className="form-text">
                Choose one .json or .nsipro file after selecting images to reference it from uploaded images, or choose a metadata file by itself and click Load Metadata to associate it with the whole project.
              </small>
              {associatedMetadataParsing && (
                <div className="form-text" role="status">Parsing associated metadata…</div>
              )}
              {associatedMetadataBundle && !associatedMetadataError && (
                <div className="form-text" role="status">
                  Parsed {associatedMetadataBundle.value.filename} as {associatedMetadataBundle.key}.
                </div>
              )}
              {associatedMetadataSaved && (
                <div className="alert alert-success" role="status">
                  Loaded {associatedMetadataSaved.filename} as project metadata. It will display with every image or slice in this project.
                </div>
              )}
              {associatedMetadataError && (
                <div className="alert alert-danger" role="alert">{associatedMetadataError}</div>
              )}
            </fieldset>
          </div>

          <div className="form-group">
            <label htmlFor="metadata-input">Metadata (Optional JSON)</label>
            <textarea
              id="metadata-input"
              rows="3"
              placeholder='{"key": "value"}'
              value={uploadMetadata}
              onChange={(e) => setUploadMetadata(e.target.value)}
            ></textarea>
          </div>

          <div className="form-group">
            <button
              type="submit"
              className="btn btn-success"
              disabled={dataOperationBusy || !extractorConfig.isValid || associatedMetadataParsing || Boolean(associatedMetadataError)}
            >
              {uploading ? 'Uploading...' : 'Upload Images'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginLeft: '8px' }}
              disabled={dataOperationBusy}
              onClick={handleLoadTestData}
            >
              {loadingTestData ? 'Loading Test Data...' : 'Load Test Data'}
            </button>
            {String(projectType || '').toUpperCase() === 'PT3' && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginLeft: '8px' }}
                disabled={dataOperationBusy}
                onClick={handleLoadNistTestData}
              >
                {loadingNistTestData ? 'Loading NIST CoCr Volume...' : 'Load NIST CoCr Volume'}
              </button>
            )}
            {uploading && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginLeft: '8px' }}
                onClick={() => {
                  cancelledRef.current = true;
                  uploadAbortControllerRef.current?.abort();
                }}
              >
                Cancel
              </button>
            )}
          </div>
          {uploadProgress && (
            <div style={{ marginTop: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '4px' }}>
                <span>{progressLabel(uploadProgress)}</span>
                {uploadProgress.failed > 0 && (
                  <span style={{ color: '#dc3545' }}>{uploadProgress.failed} failed</span>
                )}
              </div>
              <div
                role="progressbar"
                aria-label="Image upload data progress"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={progressPercent(uploadProgress)}
                style={{ width: '100%', height: '8px', backgroundColor: '#e9ecef', borderRadius: '4px', overflow: 'hidden' }}
              >
                <div
                  style={{
                    width: `${progressPercent(uploadProgress)}%`,
                    height: '100%',
                    backgroundColor: uploadProgress.failed > 0 ? '#ffc107' : '#28a745',
                    transition: 'width 0.2s',
                  }}
                />
              </div>
            </div>
          )}
          {testDataResult && (
            <div className="alert alert-success" data-testid="load-test-data-result">
              Loaded {testDataResult.images_created || 0} new {projectType || 'project'} test images;
              {' '}
              created {testDataResult.ingest?.counters?.parts_created || 0} parts.
            </div>
          )}
          {nistTestDataResult && (
            <div className="alert alert-success" data-testid="load-nist-cocr-result">
              Loaded {nistTestDataResult.images_created || 0} new NIST CoCr test images;
              {' '}
              created {nistTestDataResult.ingest?.counters?.parts_created || 0}
              {' '}
              {(nistTestDataResult.ingest?.counters?.parts_created || 0) === 1 ? 'part' : 'parts'}.
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default ImageUploader;
