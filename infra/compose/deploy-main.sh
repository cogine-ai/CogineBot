#!/usr/bin/env bash
# Build and roll out origin/main on the single-VM production stack.
# Install as /usr/local/sbin/rakazo-deploy-main; the deploy user needs sudo Docker access.
set -Eeuo pipefail
umask 077
export LC_ALL=C

if [[ -z "${RAKAZO_DEPLOY_DIR:-}" && -r /etc/rakazo/deploy.env ]]; then
  # shellcheck disable=SC1091
  source /etc/rakazo/deploy.env
fi
APP_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
COMPOSE_FILE="infra/compose/docker-compose.prod.yml"
BUILD_TIMEOUT="${RAKAZO_DEPLOY_BUILD_TIMEOUT:-15m}"
UP_TIMEOUT="${RAKAZO_DEPLOY_UP_TIMEOUT:-5m}"
ROLLBACK_TIMEOUT="${RAKAZO_DEPLOY_ROLLBACK_TIMEOUT:-8m}"
MIN_FREE_GB="${RAKAZO_DEPLOY_MIN_FREE_GB-5}"
BUILDKIT_IMAGE="moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c"
MAX_INTEGER=9223372036854775807

fail() { echo "$*" >&2; return 1; }
is_uint() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  ((${#1} < 19)) || { ((${#1} == 19)) && [[ "$1" < "9223372036854775808" ]]; }
}
is_path() { [[ "$1" == /* && ! "$1" =~ [[:cntrl:]] ]]; }
mode_of() { stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1"; }
owned_file() { [[ -f "$1" && ! -L "$1" && -O "$1" ]]; }
state_file_safe() { owned_file "$1" && [[ "$(mode_of "$1")" == 600 ]]; }

is_uint "${MIN_FREE_GB}" && ((MIN_FREE_GB <= MAX_INTEGER / 1024 / 1024)) ||
  fail "RAKAZO_DEPLOY_MIN_FREE_GB must be a nonnegative whole GiB within the supported integer range"
if [[ "${COMPOSE_PROJECT_NAME+x}" == x ]]; then
  [[ "${COMPOSE_PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
    fail "COMPOSE_PROJECT_NAME must be a nonempty valid Compose project name when set"
fi
reserve_kb=$((MIN_FREE_GB * 1024 * 1024))
is_path "${APP_DIR}" || fail "RAKAZO_DEPLOY_DIR must be an absolute path without control characters"
cd -- "${APP_DIR}"
APP_DIR="$(pwd -P)"
for command in jq timeout sudo docker df awk git stat mktemp chmod mv wc flock curl sed tail tr rm; do
  command -v "${command}" >/dev/null || fail "Deployment requires ${command}; install the documented prerequisites first"
done
if command -v sha256sum >/dev/null; then hash_command=(sha256sum); else
  command -v shasum >/dev/null || fail "Deployment requires SHA-256 tooling"
  hash_command=(shasum -a 256)
fi

# Carry the caller's Compose selectors across sudo without changing its environment policy.
compose_args=(--env-file .env -f "${COMPOSE_FILE}")
if [[ "${COMPOSE_PROFILES+x}" == x ]]; then
  profiles="$(jq -cn --arg profiles "${COMPOSE_PROFILES}" '
    def trimspace: gsub("^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$"; "");
    $profiles | (if . == "" then [""] else split(",") end) | map(trimspace)')"
  while IFS= read -r -d '' profile; do compose_args+=(--profile "${profile}"); done < <(jq -j '.[]+"\u0000"' <<<"${profiles}")
fi
config_args=("${compose_args[@]}")
if [[ "${COMPOSE_PROJECT_NAME+x}" == x ]]; then config_args+=(--project-name "${COMPOSE_PROJECT_NAME}"); fi

# The installed entrypoint must not truncate an unexpected link or special file.
[[ ! -L "${APP_DIR}/.deploy.lock" ]] || fail "The deployment lock must not be a symbolic link"
if [[ -e "${APP_DIR}/.deploy.lock" ]]; then
  owned_file "${APP_DIR}/.deploy.lock" || fail "The deployment lock must be an owned regular file"
fi
exec 9>>"${APP_DIR}/.deploy.lock"
if ! flock -n 9; then
  echo "Another production deployment holds the lock; refusing to report success." >&2
  exit 1
fi

raw_docker() { timeout --kill-after=30s 1m sudo docker "$@"; }
if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
  context="${DOCKER_CONTEXT}"
  [[ "${context}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "Cannot identify the effective Docker context"
  endpoint="$(raw_docker --context "${context}" context inspect "${context}" | jq -er --arg context "${context}" \
    'if type == "array" and length == 1 and .[0].Name == $context then .[0].Endpoints.docker.Host else error("ambiguous context") end')"
elif [[ -n "${DOCKER_HOST:-}" ]]; then
  endpoint="${DOCKER_HOST}"
else
  context="$(raw_docker context show)"
  [[ "${context}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "Cannot identify the effective Docker context"
  endpoint="$(raw_docker context inspect "${context}" | jq -er --arg context "${context}" \
    'if type == "array" and length == 1 and .[0].Name == $context then .[0].Endpoints.docker.Host else error("ambiguous context") end')"
fi
[[ "${endpoint}" == unix:///* && ! "${endpoint}" =~ [[:cntrl:]] ]] ||
  fail "Deployment storage checks require a local Unix-socket Docker engine"
# Pin the resolved engine for every operation; do not change the operator's context or credentials.
docker_command() {
  local limit="$1"; shift
  timeout --kill-after=30s "${limit}" sudo docker --host "${endpoint}" "$@"
}
compose() { local limit="$1"; shift; docker_command "${limit}" compose --project-name "${project}" "${compose_args[@]}" "$@"; }
healthy() {
  curl --fail --silent --show-error --max-time 15 "${RAKAZO_HEALTH_URL}" >/dev/null &&
    compose 5s exec -T api node -e \
      "fetch('http://127.0.0.1:3100/ready',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null
}
if [[ -z "${RAKAZO_HEALTH_URL:-}" ]]; then
  host="$(sed -n 's/^RAKAZO_HOST=//p' .env | tail -n 1)"
  [[ -n "${host}" ]] || fail "Set RAKAZO_HOST in .env or RAKAZO_HEALTH_URL"
  RAKAZO_HEALTH_URL="https://${host}/health"
fi
command -v curl >/dev/null || fail "Deployment requires curl"
version="$(docker_command 1m buildx version)"
[[ "${version}" =~ v([0-9]+)\.([0-9]+)\.([0-9]+) ]] || fail "Cannot determine the Buildx version"
major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"
is_uint "${major}" && is_uint "${minor}" && ((major > 0 || minor >= 14)) || fail "Deployment requires Buildx 0.14 or newer"
build_help="$(docker_command 1m compose build --help)"
[[ "${build_help}" == *--builder* ]] || fail "Deployment requires Docker Compose build --builder support"
pull_help="$(docker_command 1m compose pull --help)"
[[ "${pull_help}" == *--ignore-buildable* && "${pull_help}" == *--policy* ]] ||
  fail "Deployment requires Docker Compose pull --ignore-buildable and --policy support"

engine="$(docker_command 1m info --format '{{json .}}' | jq -cse \
  'if length == 1 and (.[0].ID | type == "string") and (.[0].DockerRootDir | type == "string") then .[0] | {ID,DockerRootDir} else error("invalid engine metadata") end')"
daemon_id="$(jq -r .ID <<<"${engine}")"
[[ "${daemon_id}" =~ ^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$ ]] || fail "Cannot identify the Docker daemon"
check_engine() {
  local current
  current="$(docker_command 1m info --format '{{json .}}' | jq -cse '
    if length == 1 then .[0] | {ID,DockerRootDir} else error("ambiguous engine metadata") end')"
  [[ "${current}" == "${engine}" ]] || fail "The local Docker engine identity changed"
}
docker_root="$(jq -r .DockerRootDir <<<"${engine}")"
is_path "${docker_root}" && [[ -d "${docker_root}" ]] || fail "DockerRootDir must be an existing absolute local directory"

read_config() {
  docker_command 1m compose "${config_args[@]}" config --format json | jq -cse '
    if length != 1 then error("ambiguous Compose config") else .[0] end |
    if (.name | type != "string") or (.name | test("^[a-z0-9][a-z0-9_-]*$") | not) or
       (.services | type != "object") or (.services | length == 0 or length > 256) then error("invalid Compose config") else
      {project:.name,services:(.services | to_entries | map(
        if (.key | test("^[A-Za-z0-9][A-Za-z0-9_.-]*$") | not) or
           (.value.image | type != "string") or (.value.image | test("[[:space:][:cntrl:]]")) or
           (.value.image | startswith("-")) or (.value.image | length == 0)
        then error("invalid service image")
        elif (.value.image | test("(^|/)coginebot-deploy-[0-9a-f]{32}(:|@|$)"))
        then error("reserved deployment image namespace")
        else {service:.key,image:.value.image,build:(.value.build != null)} end) | sort_by(.service))}
    end'
}
config="$(read_config)"; project="$(jq -r .project <<<"${config}")"
owner_id="$(printf '%s\0' "${APP_DIR}" "${project}" "${daemon_id}" "${endpoint}" | "${hash_command[@]}" | awk '{print $1}')"
[[ "${owner_id}" =~ ^[0-9a-f]{64}$ ]] || fail "Cannot derive deployment ownership"
builder="coginebot-deploy-${owner_id:0:32}"; node="${builder}0"
builder_container="buildx_buildkit_${node}"; builder_volume="${builder_container}_state"
namespace="coginebot-deploy-${owner_id:0:32}"
owner="$(jq -cn --arg id "${owner_id}" --arg appDir "${APP_DIR}" --arg project "${project}" \
  --arg daemonId "${daemon_id}" --arg endpoint "${endpoint}" '{id:$id,appDir:$appDir,project:$project,daemonId:$daemonId,endpoint:$endpoint}')"
state_dir="$(git rev-parse --git-path coginebot-deploy)"
[[ "${state_dir}" == /* ]] || state_dir="${APP_DIR}/${state_dir}"
state_parent="${state_dir%/*}"
[[ -d "${state_parent}" && ! -L "${state_parent}" && -O "${state_parent}" ]] || fail "Deployment state requires owned Git metadata"
state_parent="$(cd -- "${state_parent}" && pwd -P)"; state_dir="${state_parent}/coginebot-deploy"
state_file="${state_dir}/state.json"
legacy_file="${APP_DIR}/.last-deployed-revision"
if [[ -e "${legacy_file}" || -L "${legacy_file}" ]]; then
  owned_file "${legacy_file}" || fail "The deployment revision must be an owned regular file"
fi
legacy_existed=0
legacy_before='""'
legacy_write_started=0
if [[ -e "${legacy_file}" ]]; then
  legacy_bytes="$(wc -c <"${legacy_file}" | tr -d '[:space:]')"
  is_uint "${legacy_bytes}" && ((legacy_bytes <= 4096)) || fail "The deployment revision record is too large"
  legacy_existed=1
  legacy_before="$(jq -Rs . "${legacy_file}")"
fi
if [[ -e "${state_dir}" || -L "${state_dir}" ]]; then
  [[ -d "${state_dir}" && ! -L "${state_dir}" && -O "${state_dir}" && "$(mode_of "${state_dir}")" == 700 ]] ||
    fail "Deployment state must be an owned mode-0700 directory"
fi

# Capacity is observed before any deletion or resource creation. Zero disables only the reserve.
read_space() {
  local dir value
  space_ok=1
  for dir in "${APP_DIR}" "${docker_root}"; do
    value="$(df -Pk "${dir}" | awk 'NR == 2 { print $4 } END { if (NR != 2) exit 1 }')" || fail "Cannot read deployment disk space"
    is_uint "${value}" || fail "Invalid deployment disk-space measurement"
    ((value >= reserve_kb)) || space_ok=0
  done
}
require_space() { read_space; [[ "${space_ok}" == 1 ]] || fail "Insufficient deployment disk space; keep protected images and free capacity before retrying"; }
read_space

state=""
check_state() {
  jq -cse --argjson owner "${owner}" --arg builder "${builder}" --arg node "${node}" --arg volume "${builder_volume}" --arg ns "${namespace}" '
    def imageid: type == "string" and test("^sha256:[0-9a-f]{64}$");
    def image: type == "object" and keys == ["id","ref"] and (.id|imageid) and .ref == ($ns+":"+(.id|ltrimstr("sha256:")));
    def services: type == "array" and length <= 256 and all(.[]; type == "object" and keys == ["id","ref","service"] and
      (.id|imageid) and (.service|type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]*$")) and .ref == ($ns+":"+(.id|ltrimstr("sha256:")))) and
      (map(.service)|unique|length) == length;
    if length != 1 then error("ambiguous state") else .[0] end |
    if type != "object" or keys != ["builder","healthy","images","owner","version"] or .version != 1 or .owner != $owner or
      (.builder|type != "object") or (.builder|keys != ["containerId","imageId","name","node","volume"]) or
      .builder.name != $builder or .builder.node != $node or .builder.volume != $volume or
      (.builder.containerId|type != "string" or (test("^[0-9a-f]{64}$")|not)) or (.builder.imageId|imageid|not) or
      (.images|type != "array" or length > 4096 or (all(.[];image)|not) or (map(.ref)|unique|length) != length) or
      (.healthy != null and ((.healthy|type != "object") or (.healthy|keys != ["previous","revision","services"]) or
        (.healthy.revision|type != "string" or (test("^([0-9a-f]{40}|[0-9a-f]{64})$")|not)) or
        (.healthy.services|services|not) or (.healthy.services|length == 0) or (.healthy.previous|services|not)))
    then error("invalid deployment state") else . end |
    . as $s | if all((.healthy.services[]?,.healthy.previous[]?); . as $v | any($s.images[]; .id == $v.id and .ref == $v.ref)) then . else error("unrecorded protected image") end'
}
if [[ -e "${state_file}" || -L "${state_file}" ]]; then
  state_file_safe "${state_file}" || fail "Deployment state must be an owned mode-0600 regular file"
  state_bytes="$(wc -c <"${state_file}" | tr -d '[:space:]')"
  is_uint "${state_bytes}" && ((state_bytes <= 1048576)) || fail "Deployment state is too large"
  state="$(check_state <"${state_file}")" || fail "Deployment state is invalid; inspect it before retrying"
fi

temporary_files=()
generation_committed=0
publishing_healthy=0
cleanup_files() {
  local file
  if ((${#temporary_files[@]} > 0)); then
    for file in "${temporary_files[@]}"; do
      if owned_file "${file}"; then rm -f -- "${file}"; fi
    done
  fi
}
trap cleanup_files EXIT
write_json() {
  local destination="$1" value="$2" temporary
  if [[ -e "${destination}" || -L "${destination}" ]]; then
    state_file_safe "${destination}" || fail "Deployment metadata must be an owned mode-0600 regular file"
  fi
  temporary="$(mktemp "${state_dir}/.metadata.XXXXXX")"
  temporary_files+=("${temporary}")
  chmod 600 "${temporary}"
  printf '%s\n' "${value}" >"${temporary}"
  if ! mv -- "${temporary}" "${destination}"; then
    # A failed acknowledgement may follow a completed rename. Keep the published generation.
    if [[ "${destination}" == "${state_file}" ]] && state_file_safe "${state_file}"; then
      local published
      if published="$(check_state <"${state_file}")" && [[ "${published}" == "${value}" ]]; then
        state="${published}"
        if [[ "${publishing_healthy}" == 1 ]]; then generation_committed=1; fi
        echo "Deployment metadata was published but its rename reported failure; inspect the state before retrying." >&2
      fi
    fi
    return 1
  fi
}
publish_state() { state="$(check_state <<<"$1")"; write_json "${state_file}" "${state}"; }

# A successful complete inventory establishes absence; an inspect failure never does.
read_containers() {
  local rows ids id
  rows="$(docker_command 1m container ls --all --no-trunc --format '{{json .}}' | jq -cs \
    'if all(.[]; (.ID|type == "string" and test("^[0-9a-f]{64}$")) and (.Names|type == "string")) then . else error("invalid container inventory") end')"
  ids="$(jq -r '.[].ID' <<<"${rows}")"
  containers='[]'
  if [[ -n "${ids}" ]]; then
    local list=(); while IFS= read -r id; do list+=("${id}"); done <<<"${ids}"
    containers="$(docker_command 1m container inspect "${list[@]}" | jq -cse --argjson rows "${rows}" '
      if length != 1 then error("ambiguous inspect") else .[0] end |
      if type == "array" and length == ($rows|length) and (map(.Id)|sort) == ($rows|map(.ID)|sort) and
        all(.[]; (.Id|type == "string" and test("^[0-9a-f]{64}$")) and (.Image|type == "string" and test("^sha256:[0-9a-f]{64}$")) and
          (.Config.Labels == null or (.Config.Labels|type == "object")) and (.Name|type == "string" and startswith("/")) and
          (.State.Status|type == "string" and length > 0))
      then . else error("invalid container inspection") end')"
  fi
}
read_images() {
  images="$(docker_command 1m image ls --all --no-trunc --format '{{json .}}' | jq -cs \
    'if all(.[]; (.ID|type == "string" and test("^sha256:[0-9a-f]{64}$")) and (.Repository|type == "string") and (.Tag|type == "string")) then . else error("invalid image inventory") end')"
}
inspect_image() {
  docker_command 1m image inspect "$1" | jq -cse '
    if length != 1 then error("ambiguous image inspection") else .[0] end |
    if type == "array" and length == 1 and (.[0].Id|type == "string" and test("^sha256:[0-9a-f]{64}$")) and
      (.[0].RepoTags == null or (.[0].RepoTags|type == "array" and all(.[];type == "string"))) and
      (.[0].RepoDigests == null or (.[0].RepoDigests|type == "array" and all(.[];type == "string"))) then .[0] else error("invalid image metadata") end'
}
read_builders() {
  builders="$(docker_command 1m buildx ls --format '{{json .Builder}}' | jq -cs \
    'if all(.[]; type == "object" and (.Name|type == "string")) then unique else error("invalid builder inventory") end')"
}
read_volumes() {
  volumes="$(docker_command 1m volume ls --format '{{json .}}' | jq -cs \
    'if all(.[]; (.Name|type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]*$"))) then . else error("invalid volume inventory") end')"
}
validate_builder() {
  local metadata actual volume
  read_builders
  metadata="$(jq -ce --arg name "${builder}" --arg node "${node}" --arg endpoint "${endpoint}" --arg image "${BUILDKIT_IMAGE}" '
    map(select(.Name == $name)) | if length == 1 and .[0].Driver == "docker-container" and (.[0].Nodes|length == 1) and
      .[0].Nodes[0].Name == $node and .[0].Nodes[0].Endpoint == $endpoint and
      .[0].Nodes[0].DriverOpts["default-load"] == "true" and .[0].Nodes[0].DriverOpts.image == $image
    then .[0] else error("builder ownership or options changed") end' <<<"${builders}")"
  actual="$(docker_command 1m container inspect "${builder_container}" | jq -cse --arg name "/${builder_container}" --arg volume "${builder_volume}" --arg image "${BUILDKIT_IMAGE}" '
    if length != 1 then error("ambiguous builder container") else .[0] end |
    if type == "array" and length == 1 and .[0].Name == $name and (.[0].Id|type == "string" and test("^[0-9a-f]{64}$")) and
      (.[0].Image|type == "string" and test("^sha256:[0-9a-f]{64}$")) and .[0].Config.Image == $image and
      (.[0].Mounts|length == 1) and .[0].Mounts[0].Type == "volume" and .[0].Mounts[0].Name == $volume and
      .[0].Mounts[0].Destination == "/var/lib/buildkit" then .[0] else error("builder container ownership changed") end')"
  volume="$(docker_command 1m volume inspect "${builder_volume}" | jq -cse --arg name "${builder_volume}" '
    if length != 1 then error("ambiguous cache volume") else .[0] end |
    if type == "array" and length == 1 and .[0].Name == $name and .[0].Driver == "local" then .[0] else error("builder volume ownership changed") end')"
  builder_receipt="$(jq -cn --arg name "${builder}" --arg node "${node}" --arg volume "${builder_volume}" --argjson actual "${actual}" \
    '{name:$name,node:$node,containerId:$actual.Id,volume:$volume,imageId:$actual.Image}')"
  if [[ -n "${state}" ]]; then
    jq -e --argjson actual "${builder_receipt}" '.builder == $actual' <<<"${state}" >/dev/null || fail "The recorded deployment builder was replaced"
  fi
}

read_containers; read_images; read_builders; read_volumes
created_builder=0
if [[ -z "${state}" ]]; then
  [[ "${space_ok}" == 1 ]] || fail "Insufficient deployment disk space; no owned cache is available for cleanup"
  jq -e --arg name "${builder}" 'all(.[];.Name != $name)' <<<"${builders}" >/dev/null || fail "An unrecorded deployment builder already exists"
  jq -e --arg name "${builder_container}" 'all(.[];.Name != ("/"+$name))' <<<"${containers}" >/dev/null || fail "An unrecorded BuildKit container already exists"
  jq -e --arg name "${builder_volume}" 'all(.[];.Name != $name)' <<<"${volumes}" >/dev/null || fail "An unrecorded BuildKit volume already exists"
  if [[ ! -d "${state_dir}" ]]; then
    mkdir -m 700 -- "${state_dir}"
    chmod 700 "${state_dir}"
    chmod g-s "${state_dir}"
  fi
  check_engine
  docker_command 1m buildx create --name "${builder}" --node "${node}" --driver docker-container \
    --driver-opt default-load=true --driver-opt "image=${BUILDKIT_IMAGE}" "${endpoint}" >/dev/null
  check_engine
  docker_command 5m buildx inspect --bootstrap "${builder}" >/dev/null
  validate_builder
  initial="$(jq -cn --argjson owner "${owner}" --argjson builder "${builder_receipt}" \
    '{version:1,owner:$owner,builder:$builder,images:[],healthy:null}')"
  publish_state "${initial}"
  created_builder=1
  require_space
else
  validate_builder
fi

capture_services() {
  current_services="$(jq -cn --arg project "${project}" --arg ns "${namespace}" --argjson config "${config}" --argjson containers "${containers}" '
    [$config.services[].service as $service |
      [$containers[] | select(.Config.Labels["com.docker.compose.project"] == $project and
        .Config.Labels["com.docker.compose.service"] == $service and ((.Config.Labels["com.docker.compose.oneoff"] // "false")|ascii_downcase) != "true" and .State.Status == "running") | .Image] | unique |
      if length > 1 then error("ambiguous service images") elif length == 1 then
        {service:$service,id:.[0],ref:($ns+":"+(.[0]|ltrimstr("sha256:")))} else empty end] | sort_by(.service)')"
  current_complete=0
  if [[ "$(jq length <<<"${current_services}")" == "$(jq '.services|length' <<<"${config}")" ]]; then current_complete=1; fi
}
record_image() {
  local id="$1" ref actual next
  ref="${namespace}:${id#sha256:}"
  actual="$(inspect_image "${id}")"; [[ "$(jq -r .Id <<<"${actual}")" == "${id}" ]] || fail "Protected image identity changed"
  if jq -e --arg ref "${ref}" --arg id "${id}" 'any(.images[];.ref == $ref and .id == $id)' <<<"${state}" >/dev/null; then
    actual="$(inspect_image "${ref}")"; [[ "$(jq -r .Id <<<"${actual}")" == "${id}" ]] || fail "A recorded image reference changed"
    return
  fi
  read_images
  jq -e --arg ref "${ref}" 'all(.[];(.Repository+":"+.Tag) != $ref)' <<<"${images}" >/dev/null || fail "An unrecorded deployment image reference already exists"
  check_engine
  docker_command 1m image tag "${id}" "${ref}"
  actual="$(inspect_image "${ref}")"; [[ "$(jq -r .Id <<<"${actual}")" == "${id}" ]] || fail "Could not protect the exact deployment image"
  next="$(jq -c --arg ref "${ref}" --arg id "${id}" '.images += [{ref:$ref,id:$id}]' <<<"${state}")"
  publish_state "${next}"
}
image_has_only_recorded_refs() {
  jq -c --arg id "$1" --argjson ledger "$(jq .images <<<"${state}")" \
    '(.RepoDigests // [] | length == 0) and all((.RepoTags // [])[]; . as $ref | any($ledger[];.ref == $ref and .id == $id))' <<<"$2"
}
read_containers; capture_services
before_services="${current_services}"; rollback_complete="${current_complete}"
while IFS= read -r id; do [[ -z "${id}" ]] || record_image "${id}"; done < <(jq -r 'map(.id)|unique[]' <<<"${before_services}")
# Verify all retained generations before authorizing any cache or image deletion.
while IFS=$'\t' read -r ref id; do
  [[ -n "${ref}" ]] || continue
  actual="$(inspect_image "${ref}")"; [[ "$(jq -r .Id <<<"${actual}")" == "${id}" ]] || fail "A retained deployment image is missing or changed"
done < <(jq -r '(.healthy.services[]?,.healthy.previous[]?)|[.ref,.id]|@tsv' <<<"${state}")
protected_ids="$(jq -cn --argjson current "${before_services}" --argjson state "${state}" \
  '[$current[].id,$state.healthy.services[]?.id,$state.healthy.previous[]?.id]|unique')"
if [[ "${created_builder}" != 1 ]]; then
  check_engine
  if ! docker_command 5m buildx prune --builder "${builder}" --all --force --filter until=24h >/dev/null; then
    read_space
    fail "The owned deployment build-cache cleanup failed; no deployment was started"
  fi
fi
while IFS=$'\t' read -r ref id; do
  [[ -n "${ref}" ]] || continue
  if jq -e --arg id "${id}" 'index($id) != null' <<<"${protected_ids}" >/dev/null; then continue; fi
  check_engine
  read_images
  ref_present="$(jq -c --arg ref "${ref}" 'any(.[];(.Repository+":"+.Tag) == $ref)' <<<"${images}")"
  if [[ "${ref_present}" == false ]]; then
    # A prior removal may have completed before its ledger update. Retire only verified obsolete metadata.
    id_present="$(jq -c --arg id "${id}" 'any(.[];.ID == $id)' <<<"${images}")"
    if [[ "${id_present}" == true ]]; then
      actual="$(inspect_image "${id}")"; [[ "$(jq -r .Id <<<"${actual}")" == "${id}" ]] || fail "An obsolete deployment image identity changed"
      private_image="$(image_has_only_recorded_refs "${id}" "${actual}")"
      [[ "${private_image}" == true ]] || continue
    fi
    read_containers
    if jq -e --arg id "${id}" 'any(.[];.Image == $id)' <<<"${containers}" >/dev/null; then continue; fi
    check_engine
    next="$(jq -c --arg ref "${ref}" '.images |= map(select(.ref != $ref))' <<<"${state}")"; publish_state "${next}"
    continue
  fi
  actual="$(inspect_image "${ref}")"; [[ "$(jq -r .Id <<<"${actual}")" == "${id}" ]] || fail "A cleanup image reference changed"
  private_image="$(image_has_only_recorded_refs "${id}" "${actual}")"
  [[ "${private_image}" == true ]] || continue
  read_containers
  if jq -e --arg id "${id}" 'any(.[];.Image == $id)' <<<"${containers}" >/dev/null; then continue; fi
  # Recheck the exact reference immediately before a non-forced, name-only removal.
  actual="$(inspect_image "${ref}")"; [[ "$(jq -r .Id <<<"${actual}")" == "${id}" ]] || fail "A cleanup image reference changed"
  private_image="$(image_has_only_recorded_refs "${id}" "${actual}")"
  [[ "${private_image}" == true ]] || continue
  check_engine
  if ! docker_command 1m image rm "${ref}" >/dev/null; then
    read_space
    fail "An owned deployment image could not be removed; no deployment was started"
  fi
  next="$(jq -c --arg ref "${ref}" '.images |= map(select(.ref != $ref))' <<<"${state}")"; publish_state "${next}"
done < <(jq -r '.images[]|[.ref,.id]|@tsv' <<<"${state}")
require_space

previous_revision="$(git rev-parse HEAD)"
git fetch --quiet --prune origin main
target_revision="$(git rev-parse origin/main)"
deployed_revision=""
if [[ -e "${legacy_file}" || -L "${legacy_file}" ]]; then
  deployed_revision="$(tr -d '[:space:]' <"${legacy_file}")"
fi
if [[ "${previous_revision}" == "${target_revision}" && "${deployed_revision}" == "${target_revision}" ]] &&
  jq -e --arg revision "${target_revision}" --argjson actual "${before_services}" \
    '.healthy != null and .healthy.revision == $revision and (.healthy.services|sort_by(.service)) == $actual' <<<"${state}" >/dev/null &&
  [[ "${rollback_complete}" == 1 ]] && healthy; then
  echo "Production is already at ${target_revision} and healthy."
  exit 0
fi

restore_legacy() {
  local current='""' temporary
  if [[ -e "${legacy_file}" || -L "${legacy_file}" ]]; then
    owned_file "${legacy_file}" || return 1
    current="$(jq -Rs . "${legacy_file}")" || return 1
  fi
  if [[ "${legacy_existed}" == 1 ]]; then
    if [[ "${current}" == "${legacy_before}" ]]; then return 0; fi
    temporary="$(mktemp "${state_dir}/.revision.XXXXXX")" || return 1
    temporary_files+=("${temporary}")
    chmod 600 "${temporary}" || return 1
    jq -jr . <<<"${legacy_before}" >"${temporary}" || return 1
    mv -- "${temporary}" "${legacy_file}" || return 1
  elif [[ -e "${legacy_file}" ]]; then
    [[ "${legacy_write_started}" == 1 ]] || return 1
    [[ "${current}" == "$(jq -cn --arg revision "${target_revision}" '$revision+"\n"')" ]] || return 1
    rm -f -- "${legacy_file}" || return 1
  fi
}

rollback() {
  trap - ERR
  if [[ "${generation_committed}" == 1 ]]; then
    echo "The healthy deployment generation was published; a later operation failed. Inspect the deployment state before retrying." >&2
    exit 1
  fi
  echo "Deployment failed; restoring the previous revision ${previous_revision}." >&2
  if ! git reset --hard "${previous_revision}" >/dev/null; then echo "Rollback failed while restoring the checkout." >&2; exit 1; fi
  if ! restore_legacy; then
    echo "The prior deployment revision record could not be restored; the healthy image receipt remains authoritative." >&2
  fi
  if [[ "${rollback_complete}" != 1 ]]; then
    echo "Exact-image rollback is unavailable because the previous deployment image map is incomplete." >&2
    exit 1
  fi
  local rollback_config override
  if ! rollback_config="$(read_config)"; then
    echo "The previous Compose configuration could not be resolved; exact-image rollback was not started." >&2
    exit 1
  fi
  if ! jq -e --arg project "${project}" --argjson previous "${before_services}" \
    '.project == $project and (.services|map(.service)|sort) == ($previous|map(.service)|sort)' <<<"${rollback_config}" >/dev/null; then
    echo "The previous Compose project or active services changed; exact-image rollback was not started." >&2
    exit 1
  fi
  config="${rollback_config}"
  override="$(jq -cn --argjson images "${before_services}" '{services:($images|map({key:.service,value:{image:.ref}})|from_entries)}')"
  write_json "${state_dir}/rollback.json" "${override}"
  check_engine
  if ! docker_command "${ROLLBACK_TIMEOUT}" compose --project-name "${project}" "${compose_args[@]}" \
    -f "${state_dir}/rollback.json" up -d --remove-orphans --no-build --pull never; then
    echo "Exact-image rollback could not restart the previous deployment." >&2; exit 1
  fi
  for _ in {1..30}; do
    if healthy; then
      read_containers; capture_services
      if [[ "${current_complete}" == 1 ]] && jq -e --argjson actual "${current_services}" '. == $actual' <<<"${before_services}" >/dev/null; then
        echo "The previous deployment images passed health and readiness checks." >&2
      else
        echo "Exact-image rollback service images differ from the protected previous images." >&2
      fi
      exit 1
    fi
    sleep "${RAKAZO_DEPLOY_HEALTH_INTERVAL:-2}"
  done
  echo "Exact-image rollback did not pass health and readiness checks." >&2
  exit 1
}
trap 'if ((BASH_SUBSHELL > 0)); then exit 1; else rollback; fi' ERR

git reset --hard "${target_revision}"
target_config="$(read_config)"
[[ "$(jq -r .project <<<"${target_config}")" == "${project}" ]] || fail "Target Compose project differs from the protected deployment"
config="${target_config}"
require_space
compose 1m config --quiet
check_engine
compose "${UP_TIMEOUT}" pull --ignore-buildable --policy missing
require_space
check_engine
validate_builder
compose "${BUILD_TIMEOUT}" build --builder "${builder}"
require_space
# Resolve configured tags once, then start only the protected IDs; Compose must not pull or rebuild.
expected_services='[]'
service_images="$(jq -r '.services[] | [.service,.image] | @tsv' <<<"${config}")"
while IFS=$'\t' read -r service image; do
  actual="$(inspect_image "${image}")"; id="$(jq -r .Id <<<"${actual}")"
  record_image "${id}"
  ref="${namespace}:${id#sha256:}"
  expected_services="$(jq -c --arg service "${service}" --arg id "${id}" --arg ref "${ref}" \
    '. + [{service:$service,id:$id,ref:$ref}] | sort_by(.service)' <<<"${expected_services}")"
done <<<"${service_images}"
forward_override="$(jq -cn --argjson images "${expected_services}" \
  '{services:($images | map({key:.service,value:{image:.ref}}) | from_entries)}')"
write_json "${state_dir}/forward.json" "${forward_override}"
check_engine
docker_command "${UP_TIMEOUT}" compose --project-name "${project}" "${compose_args[@]}" \
  -f "${state_dir}/forward.json" up -d --remove-orphans --no-build --pull never

for _ in {1..30}; do
  if healthy; then
    read_containers; capture_services
    [[ "${current_complete}" == 1 ]] || fail "The healthy deployment has an incomplete service image map"
    jq -e --argjson actual "${current_services}" '. == $actual' <<<"${expected_services}" >/dev/null ||
      fail "Deployment service images differ from the protected target images"
    while IFS= read -r id; do [[ -z "${id}" ]] || record_image "${id}"; done < <(jq -r 'map(.id)|unique[]' <<<"${current_services}")
    next="$(jq -c --arg revision "${target_revision}" --argjson services "${current_services}" --argjson previous "${before_services}" \
      '.healthy = {revision:$revision,services:$services,previous:$previous}' <<<"${state}")"
    # Publish compatibility evidence first. Only the final atomic state publication is authoritative.
    legacy_tmp="$(mktemp "${state_dir}/.revision.XXXXXX")"; temporary_files+=("${legacy_tmp}")
    chmod 600 "${legacy_tmp}"; printf '%s\n' "${target_revision}" >"${legacy_tmp}"
    legacy_write_started=1
    mv -- "${legacy_tmp}" "${legacy_file}"
    publishing_healthy=1
    publish_state "${next}"
    generation_committed=1
    trap - ERR
    echo "Deployed ${target_revision} successfully."
    exit 0
  fi
  sleep "${RAKAZO_DEPLOY_HEALTH_INTERVAL:-2}"
done

echo "Production health check did not recover in time." >&2
false
