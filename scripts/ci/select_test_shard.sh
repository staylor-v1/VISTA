#!/bin/sh
#
# Select one deterministic, whole-file test shard.
#
# Usage:
#   sh scripts/ci/select_test_shard.sh ROOT PATTERN INDEX TOTAL
#
# PATTERN is matched against paths relative to ROOT using find's shell-pattern
# syntax. INDEX is one-based, matching GitLab's CI_NODE_INDEX/CI_NODE_TOTAL.
# Selected paths are printed relative to the caller's current directory.

set -eu

usage() {
    echo "Usage: $0 ROOT PATTERN INDEX TOTAL" >&2
}

fail() {
    echo "select_test_shard: $*" >&2
    exit 2
}

is_positive_integer() {
    case "$1" in
        ''|*[!0-9]*)
            return 1
            ;;
    esac

    [ "$1" -ge 1 ] 2>/dev/null
}

if [ "$#" -ne 4 ]; then
    usage
    exit 2
fi

root=$1
pattern=$2
index=$3
total=$4

[ -n "$pattern" ] || fail "PATTERN must not be empty"
[ -d "$root" ] || fail "ROOT must be an existing directory: $root"
is_positive_integer "$index" || fail "INDEX must be a positive integer: $index"
is_positive_integer "$total" || fail "TOTAL must be a positive integer: $total"
[ "$index" -le "$total" ] || fail "INDEX must not exceed TOTAL"

case "$pattern" in
    /*)
        fail "PATTERN must be relative to ROOT: $pattern"
        ;;
esac

caller_directory=$(pwd -P) || fail "could not determine the current directory"
root_directory=$(
    CDPATH= cd "$root" 2>/dev/null && pwd -P
) || fail "could not resolve ROOT: $root"

# Compute ROOT relative to the caller without depending on Python or realpath.
root_relative=$(
    awk -v from="$caller_directory" -v to="$root_directory" '
        BEGIN {
            from_count = split(from, from_parts, "/")
            to_count = split(to, to_parts, "/")
            common = 1

            while (common <= from_count && common <= to_count && from_parts[common] == to_parts[common]) {
                common++
            }

            result = ""
            for (part = common; part <= from_count; part++) {
                if (from_parts[part] != "") {
                    result = result "../"
                }
            }
            for (part = common; part <= to_count; part++) {
                if (to_parts[part] != "") {
                    result = result to_parts[part] "/"
                }
            }

            sub(/\/$/, "", result)
            print result == "" ? "." : result
        }
    '
) || fail "could not make ROOT relative to the current directory"

temporary_base=${TMPDIR:-/tmp}
manifest_file=$(mktemp "$temporary_base/vista-test-shard-manifest.XXXXXX") ||
    fail "could not create a temporary manifest"
ordered_file=$(mktemp "$temporary_base/vista-test-shard-ordered.XXXXXX") || {
    rm -f "$manifest_file"
    fail "could not create a temporary ordered manifest"
}

cleanup() {
    rm -f "$manifest_file" "$ordered_file"
}
trap cleanup EXIT HUP INT TERM

(
    cd "$root_directory"
    find . -type f -path "./$pattern" -printf '%s\t%P\n'
) >"$manifest_file" || fail "could not enumerate test files under ROOT"

# Largest files are assigned first. Equal-sized files are ordered by path.
LC_ALL=C sort -t "$(printf '\t')" -k1,1nr -k2,2 "$manifest_file" \
    >"$ordered_file" || fail "could not order the test manifest"

awk \
    -F "$(printf '\t')" \
    -v requested="$index" \
    -v shard_count="$total" \
    -v root="$root_relative" '
        {
            lightest = 1
            for (shard = 2; shard <= shard_count; shard++) {
                if (load[shard] < load[lightest]) {
                    lightest = shard
                }
            }

            load[lightest] += $1
            if (lightest == requested) {
                if (root == ".") {
                    print $2
                } else {
                    print root "/" $2
                }
            }
        }
    ' "$ordered_file"
