#!/usr/bin/env bash
set -euo pipefail

# Pinned official release; verify the archive on every run before extracting it.
version=1.7.12
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) platform=linux_amd64; expected=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  Linux/aarch64|Linux/arm64) platform=linux_arm64; expected=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
  Darwin/arm64) platform=darwin_arm64; expected=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
  Darwin/x86_64) platform=darwin_amd64; expected=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
  *) echo "Unsupported actionlint platform; install actionlint ${version} and lint the active workflow manually." >&2; exit 1 ;;
esac

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cache_dir="${XDG_CACHE_HOME:-${TMPDIR:-/tmp}/coginebot-tools}/actionlint/${version}/${platform}"
archive="${cache_dir}/actionlint.tar.gz"
mkdir -p "${cache_dir}"
run_dir=$(mktemp -d "${cache_dir}/run.XXXXXX")
download="${run_dir}/archive.download"
trap 'rm -rf "${run_dir}"' EXIT
if [[ ! -f "${archive}" ]]; then
  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 90 --retry 2 \
    "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_${platform}.tar.gz" \
    --output "${download}"
  mv "${download}" "${archive}"
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "${archive}" | awk '{print $1}')
else
  actual=$(shasum -a 256 "${archive}" | awk '{print $1}')
fi
if [[ "${actual}" != "${expected}" ]]; then
  echo "actionlint archive checksum mismatch; remove the cached archive and retry." >&2
  exit 1
fi
tar -xzf "${archive}" -C "${run_dir}" actionlint
cd "${repo_root}"
"${run_dir}/actionlint" -color .github/workflows/repository-ci.yml
