#!/bin/sh
#
# Select one deterministic, whole-file test shard.
#
# Usage:
#   sh scripts/ci/select_test_shard.sh ROOT PATTERNS INDEX TOTAL [EXCLUDE_PREFIXES]
#
# PATTERNS is a comma-separated list matched against paths relative to ROOT
# using find's shell-pattern syntax. EXCLUDE_PREFIXES is an optional
# comma-separated list of directory prefixes relative to ROOT. Overlapping
# patterns are de-duplicated. INDEX is one-based, matching GitLab's
# CI_NODE_INDEX/CI_NODE_TOTAL. Selected paths are printed relative to the
# caller's current directory.

set -eu
set -f

usage() {
    echo "Usage: $0 ROOT PATTERNS INDEX TOTAL [EXCLUDE_PREFIXES]" >&2
}

fail() {
    echo "select_test_shard: $*" >&2
    exit 2
}

is_positive_integer() {
    case "$1" in
        ''|0*|*[!0-9]*)
            return 1
            ;;
    esac

    [ "$1" -ge 1 ] 2>/dev/null
}

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    usage
    exit 2
fi

root=$1
patterns=$2
index=$3
total=$4
exclude_prefixes=${5:-}
maximum_shards=64

[ -n "$patterns" ] || fail "PATTERNS must not be empty"
case "$patterns" in
    ,*|*,|*,,*)
        fail "PATTERNS must not contain an empty pattern"
        ;;
esac
[ -d "$root" ] || fail "ROOT must be an existing directory: $root"
is_positive_integer "$index" || fail "INDEX must be a positive integer: $index"
is_positive_integer "$total" || fail "TOTAL must be a positive integer: $total"
[ "$total" -le "$maximum_shards" ] ||
    fail "TOTAL must not exceed $maximum_shards"
[ "$index" -le "$total" ] || fail "INDEX must not exceed TOTAL"

old_ifs=$IFS
IFS=,
set -- $patterns
IFS=$old_ifs
[ "$#" -gt 0 ] || fail "PATTERNS must contain at least one pattern"
for pattern do
    [ -n "$pattern" ] || fail "PATTERNS must not contain an empty pattern"
    case "$pattern" in
        /*)
            fail "PATTERNS must be relative to ROOT: $pattern"
            ;;
    esac
done

if [ -n "$exclude_prefixes" ]; then
    case "$exclude_prefixes" in
        ,*|*,|*,,*)
            fail "EXCLUDE_PREFIXES must not contain an empty prefix"
            ;;
    esac
    IFS=,
    set -- $exclude_prefixes
    IFS=$old_ifs
    for exclude_prefix do
        [ -n "$exclude_prefix" ] ||
            fail "EXCLUDE_PREFIXES must not contain an empty prefix"
        case "$exclude_prefix" in
            /*|../*|*/../*|*/..)
                fail "EXCLUDE_PREFIXES must be relative to ROOT: $exclude_prefix"
                ;;
        esac
    done
fi

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
    IFS=,
    for pattern in $patterns; do
        find . -type f -path "./$pattern" -printf '%s\t%P\n'
    done
) >"$manifest_file" || fail "could not enumerate test files under ROOT"

# Exclusions are directory-prefix matches. De-duplicate paths before balancing
# so a Jest file matching both a suffix pattern and __tests__ is run once.
# Largest files are assigned first. Equal-sized files are ordered by path.
if ! awk \
    -F "$(printf '\t')" \
    -v excludes="$exclude_prefixes" '
        BEGIN {
            exclude_count = split(excludes, exclude, ",")
        }
        {
            path = $2
            skipped = 0
            for (item = 1; item <= exclude_count; item++) {
                if (exclude[item] != "" &&
                    (path == exclude[item] ||
                     index(path, exclude[item] "/") == 1)) {
                    skipped = 1
                    break
                }
            }
            if (!skipped && !seen[path]++) {
                print
            }
        }
    ' "$manifest_file" |
    LC_ALL=C sort -t "$(printf '\t')" -k1,1nr -k2,2 >"$ordered_file"; then
    fail "could not normalize and order the test manifest"
fi

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
