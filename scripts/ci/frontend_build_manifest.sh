#!/bin/sh
#
# Create or verify a deterministic digest for a built frontend directory.
#
# Usage:
#   frontend_build_manifest.sh create [BUILD_DIR] [MANIFEST]
#   frontend_build_manifest.sh verify [BUILD_DIR] [MANIFEST]

set -eu

fail() {
    echo "frontend_build_manifest: $*" >&2
    exit 2
}

usage() {
    echo "Usage: $0 {create|verify} [BUILD_DIR] [MANIFEST]" >&2
}

tree_digest() (
    digest_root=$1
    temporary_base=${TMPDIR:-/tmp}
    digest_work_directory=$(
        mktemp -d "$temporary_base/vista-frontend-digest.XXXXXX"
    ) || fail "could not create digest work directory"
    trap 'rm -rf "$digest_work_directory"' EXIT HUP INT TERM

    path_manifest="$digest_work_directory/paths"
    ordered_manifest="$digest_work_directory/ordered"
    digest_manifest="$digest_work_directory/digests"
    final_digest="$digest_work_directory/final"
    unsupported_manifest="$digest_work_directory/unsupported"

    CDPATH= cd "$digest_root" ||
        fail "could not enter build directory: $digest_root"

    # Production build artifacts must be an exact tree of directories and
    # regular files. Reject links/devices instead of silently hashing only
    # their targets (or omitting them entirely).
    find . -mindepth 1 ! -type d ! -type f -print -quit \
        >"$unsupported_manifest" ||
        fail "could not inspect build artifact types"
    if [ -s "$unsupported_manifest" ]; then
        unsupported_path=$(sed -n '1p' "$unsupported_manifest")
        fail "build directory contains unsupported file type: $unsupported_path"
    fi

    # NUL-delimited records preserve every valid POSIX filename. Each command
    # runs separately so a find/sort/hash failure cannot be masked by the final
    # sha256sum in a shell pipeline.
    find . -type f -print0 >"$path_manifest" ||
        fail "could not enumerate build files"
    LC_ALL=C sort -z "$path_manifest" >"$ordered_manifest" ||
        fail "could not order build files"
    xargs -0 sha256sum --zero <"$ordered_manifest" >"$digest_manifest" ||
        fail "could not hash every build file"
    sha256sum "$digest_manifest" >"$final_digest" ||
        fail "could not hash the build digest manifest"
    awk '{print $1}' "$final_digest"
)

[ "$#" -ge 1 ] && [ "$#" -le 3 ] || {
    usage
    exit 2
}

operation=$1
build_directory=${2:-frontend/build}
manifest_path=${3:-.ci-artifacts/frontend-build.sha256}

[ -d "$build_directory" ] ||
    fail "build directory does not exist: $build_directory"
[ -n "$(find "$build_directory" -type f -print -quit)" ] ||
    fail "build directory contains no files: $build_directory"

actual_digest=$(tree_digest "$build_directory")

case "$operation" in
    create)
        [ ! -d "$manifest_path" ] ||
            fail "manifest path must not be a directory: $manifest_path"
        manifest_directory=$(dirname "$manifest_path")
        mkdir -p "$manifest_directory"
        temporary_manifest="${manifest_path}.tmp.$$"
        trap 'rm -f "$temporary_manifest"' EXIT HUP INT TERM
        printf '%s\n' "$actual_digest" >"$temporary_manifest"
        mv "$temporary_manifest" "$manifest_path"
        trap - EXIT HUP INT TERM
        ;;
    verify)
        [ -f "$manifest_path" ] ||
            fail "manifest does not exist: $manifest_path"
        expected_digest=$(sed -n '1p' "$manifest_path")
        manifest_lines=$(wc -l <"$manifest_path" | tr -d ' ')
        [ "$manifest_lines" -eq 1 ] ||
            fail "manifest must contain exactly one line"
        [ "${#expected_digest}" -eq 64 ] ||
            fail "manifest digest must contain 64 hexadecimal characters"
        case "$expected_digest" in
            *[!0-9a-f]*)
                fail "manifest digest must use lowercase hexadecimal characters"
                ;;
        esac
        [ "$actual_digest" = "$expected_digest" ] ||
            fail "frontend build does not match $manifest_path"
        ;;
    *)
        usage
        exit 2
        ;;
esac
