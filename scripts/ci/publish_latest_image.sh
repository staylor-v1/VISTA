#!/bin/sh
#
# Promote an immutable CI image to `latest` without allowing an older GitLab
# pipeline to overwrite a newer publication.

set -eu

fail() {
    echo "publish_latest_image: $*" >&2
    exit 2
}

is_bounded_positive_integer() {
    integer_value=$1
    case "$integer_value" in
        ''|0*|*[!0-9]*)
            return 1
            ;;
    esac

    # Keep comparisons within every supported shell's signed 64-bit range.
    [ "${#integer_value}" -le 18 ]
}

podman_command=${PODMAN_BIN:-podman}

[ -n "${SHA_IMAGE:-}" ] || fail "SHA_IMAGE is required"
[ -n "${LATEST_IMAGE:-}" ] || fail "LATEST_IMAGE is required"
[ -n "$podman_command" ] || fail "PODMAN_BIN must not be empty"
is_bounded_positive_integer "${CI_PIPELINE_IID:-}" ||
    fail "CI_PIPELINE_IID must be a positive integer of at most 18 digits"

"$podman_command" pull "$SHA_IMAGE"
source_pipeline_iid=$(
    "$podman_command" image inspect \
        --format '{{ index .Labels "io.vista.ci.pipeline-iid" }}' \
        "$SHA_IMAGE"
) || fail "could not inspect immutable source image"
[ "$source_pipeline_iid" = "$CI_PIPELINE_IID" ] ||
    fail "source image pipeline IID does not match this pipeline"

if latest_pull_output=$("$podman_command" pull "$LATEST_IMAGE" 2>&1); then
    latest_pipeline_iid=$(
        "$podman_command" image inspect \
            --format '{{ index .Labels "io.vista.ci.pipeline-iid" }}' \
            "$LATEST_IMAGE"
    ) || fail "could not inspect existing latest image"

    case "$latest_pipeline_iid" in
        ''|'<no value>')
            echo "Existing latest image has no pipeline IID; replacing legacy tag."
            ;;
        *)
            is_bounded_positive_integer "$latest_pipeline_iid" ||
                fail "existing latest image has an invalid pipeline IID"
            if [ "$latest_pipeline_iid" -gt "$CI_PIPELINE_IID" ]; then
                echo "Skipping stale publication: pipeline $CI_PIPELINE_IID is older than published pipeline $latest_pipeline_iid."
                exit 0
            fi
            ;;
    esac
else
    case "$latest_pull_output" in
        *"manifest unknown"*|*"name unknown"*)
            echo "No existing latest image was found; creating it."
            ;;
        *)
            printf '%s\n' "$latest_pull_output" >&2
            fail "could not read existing latest image"
            ;;
    esac
fi

"$podman_command" tag "$SHA_IMAGE" "$LATEST_IMAGE"
"$podman_command" push "$LATEST_IMAGE"
