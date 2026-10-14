/**
 * S13.1 — every external command `deploy apply` would run, as argv, run by nobody.
 *
 * D-002's rule for the whole engine holds here: Mind borrows hands. It does
 * not speak Google's or Amazon's API; it runs the `ssh`, `gcloud` and `aws` the
 * owner already has, with the owner's own logins, and a plan is the list of
 * exactly those command lines — so a person can read what would be done in
 * their name before any of it is.
 *
 * ## Three things each step is careful about
 *
 * - **Secrets never appear in an argv.** A key goes on stdin, and the step says
 *   *what* arrives there (`stdin`) without holding it. An argv is visible in
 *   `ps` to every user on both machines, and in shell history if pasted.
 * - **Personal bytes go straight onto the encrypted volume.** The repository is
 *   streamed as a git bundle and the places as tar, each piped from a local
 *   command (`pipeFrom`) into a process on the far side that writes under the
 *   volume — never a copy parked on the boot disk first.
 * - **Every word a remote shell will read is checked.** `ssh host -- a b c`
 *   hands the far side one string to parse, so a word with a space or a `;` in
 *   it would be split or run. Every remote word is built from constants, the
 *   subject id and the target's validated name, and {@link remote} throws if
 *   one ever is not shell-plain — a programming error, not a user's.
 *
 * The provider-specific part is only the start: creating the machine (GCP, AWS)
 * or finding it (a VPS). From the first `uname -m` on, the steps are one
 * bootstrap for all three, which is what S13.3 and S13.4 say they reuse.
 */

import type { SubjectId } from "../types.ts";
import { assetFor } from "../update/version.ts";
import { isIPv6, type Target } from "./target.ts";

/** One external command. Shown, never run. */
export interface Step {
  readonly what: string;
  /** The program and its arguments, exactly. A word in braces is filled in at apply time. */
  readonly argv: readonly string[];
  /** A command on this machine whose output is this command's stdin. */
  readonly pipeFrom?: readonly string[];
  /** What arrives on stdin when it is not a command — named here, never held. */
  readonly stdin?: string;
}

/** A value only apply can know, and where it comes from. */
export interface Placeholder {
  readonly name: string;
  readonly means: string;
}

/** The layout the commands write into — the plan's, passed in so the two cannot disagree. */
export interface CommandLayout {
  readonly volume: string;
  readonly home: string;
  readonly stateHome: string;
  readonly dataHome: string;
  readonly agentDir: string;
  readonly binary: string;
  readonly user: string;
}

export interface CommandInput {
  readonly target: Target;
  readonly subject: SubjectId;
  /** The agent's repository on this machine. */
  readonly agentDir: string;
  readonly layout: CommandLayout;
  /** Each place that is copied and has something in it. */
  readonly copies: readonly { readonly label: string; readonly here: string; readonly there: string }[];
  /** `enable`: started with `enable --now` — the page and the timer, not the oneshot the timer starts. */
  readonly units: readonly { readonly name: string; readonly path: string; readonly enable: boolean }[];
  readonly webPort: number;
  /** Where the keys are kept on this machine — never there. */
  readonly keys: { readonly volume: string; readonly disk: string };
  /** The container's size on a VPS. */
  readonly containerGb: number;
}

export interface CommandPlan {
  readonly steps: readonly Step[];
  readonly placeholders: readonly Placeholder[];
}

/** The device-mapper name the open volume gets. */
export const MAPPER = "mind";
/** A VPS has one disk; the volume is a file on it. */
export const VPS_CONTAINER_DIR = "/var/lib/mind";
export const VPS_CONTAINER = `${VPS_CONTAINER_DIR}/volume.luks`;
/** The device name the data disk is given on GCP. */
const GCP_DEVICE_NAME = "mind-data";
/** GCP names an attached disk by the device name it was given. */
export const GCP_DATA_DEVICE = `/dev/disk/by-id/google-${GCP_DEVICE_NAME}`;
/** Canonical's image on each provider; the release is for Linux, and S13.2 AC1 names Ubuntu. */
export const UBUNTU = "24.04";
/** The binary on its way — /tmp, because it is not anybody's data. */
const BINARY_UPLOAD = "/tmp/mind";
const TAILSCALE_INSTALLER = "/tmp/tailscale-install.sh";

/** Words a remote shell reads as themselves. Braces are a placeholder, replaced before anything runs. */
const SHELL_PLAIN = /^[A-Za-z0-9_@%+=:,./{}-]+$/;

/**
 * `base` followed by words for the far side's shell, each checked.
 *
 * @throws {Error} when a word is not shell-plain. Every word is built here from
 *   constants and validated values, so a throw is a bug in this file.
 */
export function remote(base: readonly string[], words: readonly string[]): string[] {
  for (const word of words) {
    if (!SHELL_PLAIN.test(word)) throw new Error(`not a plain word for a remote shell: ${JSON.stringify(word)}`);
  }
  return [...base, ...words];
}

/** How to reach the machine once it exists, and how to copy a file to it. */
export interface Reach {
  readonly shell: readonly string[];
  readonly copy: (local: string, path: string) => string[];
}

export function reachFor(target: Target): Reach {
  if (target.provider === "ssh") {
    const { host, user, port } = target.ssh;
    const where = isIPv6(host) ? `[${host}]` : host;
    return {
      shell: ["ssh", "-p", String(port), "-o", "BatchMode=yes", `${user}@${host}`, "--"],
      copy: (local, path) => ["scp", "-P", String(port), "-o", "BatchMode=yes", local, `${user}@${where}:${path}`],
    };
  }
  if (target.provider === "gcp") {
    const scope = ["--project", target.gcp.project, "--zone", target.gcp.zone];
    return {
      shell: ["gcloud", "compute", "ssh", target.name, ...scope, "--"],
      copy: (local, path) => ["gcloud", "compute", "scp", local, `${target.name}:${path}`, ...scope],
    };
  }
  return {
    shell: ["ssh", "-o", "BatchMode=yes", "ubuntu@{public-dns}", "--"],
    copy: (local, path) => ["scp", "-o", "BatchMode=yes", local, `ubuntu@{public-dns}:${path}`],
  };
}

/** GCP: a data disk under your key, then the VM. */
function gcpCreate(target: Extract<Target, { provider: "gcp" }>, csek: string): Step[] {
  const { project, zone, machineType, diskGb } = target.gcp;
  const scope = ["--project", project, "--zone", zone];
  const image = target.arch === "arm64" ? "arm64" : "amd64";
  const keyIn = `the disk's customer-supplied key, as gcloud's key-file JSON — made on this machine and kept at ${csek}, never written there`;
  return [
    {
      what: "create the data disk, encrypted by Google under a key you supply (CSEK), which Google does not keep",
      argv: ["gcloud", "compute", "disks", "create", `${target.name}-data`, ...scope, "--size", `${diskGb}GB`, "--type", "pd-balanced", "--csek-key-file", "-"],
      stdin: keyIn,
    },
    {
      what: `create the VM — Ubuntu ${UBUNTU} (${image}), the data disk attached and kept when the VM goes`,
      argv: [
        "gcloud", "compute", "instances", "create", target.name, ...scope,
        "--machine-type", machineType,
        "--image-family", `ubuntu-${UBUNTU.replace(".", "")}-lts-${image}`, "--image-project", "ubuntu-os-cloud",
        "--boot-disk-size", "20GB",
        "--disk", `name=${target.name}-data,device-name=${GCP_DEVICE_NAME},auto-delete=no`,
        "--csek-key-file", "-",
      ],
      stdin: keyIn,
    },
  ];
}

/** AWS: a KMS key in your account, a security group for ssh, the instance with its volume. */
function awsCreate(target: Extract<Target, { provider: "aws" }>): Step[] {
  const { region, instanceType, diskGb } = target.aws;
  const at = ["--region", region];
  const arch = target.arch === "arm64" ? "arm64" : "amd64";
  const volume = JSON.stringify([
    {
      DeviceName: "/dev/sdf",
      Ebs: { VolumeSize: diskGb, VolumeType: "gp3", Encrypted: true, KmsKeyId: "{kms-key-id}", DeleteOnTermination: false },
    },
  ]);
  return [
    {
      what: "create a KMS key in your account for EBS to encrypt the volume with (a second layer: it lives in AWS KMS)",
      argv: ["aws", "kms", "create-key", ...at, "--description", `mind ${target.name} volume`, "--tags", `TagKey=mind,TagValue=${target.name}`],
    },
    {
      what: "create a security group that will allow ssh and nothing else",
      argv: ["aws", "ec2", "create-security-group", ...at, "--group-name", `mind-${target.name}`, "--description", `mind ${target.name}: ssh only`],
    },
    {
      // D-100 #3: nothing public by default. ssh is the bootstrap channel, so it is opened to the address this
      // machine is seen from and nothing wider, and closed again once the tailnet is up (see closeBootstrapSsh).
      what: "allow tcp/22 from this machine's public address only — the bootstrap channel, closed once the tailnet is up",
      argv: ["aws", "ec2", "authorize-security-group-ingress", ...at, "--group-id", "{sg-id}", "--protocol", "tcp", "--port", "22", "--cidr", "{your-public-ip}/32"],
    },
    {
      what: "give the instance your ssh public key",
      argv: ["aws", "ec2", "import-key-pair", ...at, "--key-name", `mind-${target.name}`, "--public-key-material", "fileb://{ssh-public-key}"],
    },
    {
      what: `start the instance — Ubuntu ${UBUNTU} (${arch}), IMDSv2 only, the volume kept when the instance goes`,
      argv: [
        "aws", "ec2", "run-instances", ...at,
        "--image-id", `resolve:ssm:/aws/service/canonical/ubuntu/server/${UBUNTU}/stable/current/${arch}/hvm/ebs-gp3/ami-id`,
        "--instance-type", instanceType,
        "--key-name", `mind-${target.name}`,
        "--security-group-ids", "{sg-id}",
        "--metadata-options", "HttpTokens=required,HttpEndpoint=enabled",
        "--block-device-mappings", volume,
        "--tag-specifications", `ResourceType=instance,Tags=[{Key=Name,Value=${target.name}}]`, `ResourceType=volume,Tags=[{Key=Name,Value=${target.name}-data}]`,
      ],
    },
    { what: "wait until it runs", argv: ["aws", "ec2", "wait", "instance-running", ...at, "--instance-ids", "{instance-id}"] },
    {
      what: "ask for its public name",
      argv: ["aws", "ec2", "describe-instances", ...at, "--instance-ids", "{instance-id}", "--query", "Reservations[0].Instances[0].PublicDnsName", "--output", "text"],
    },
  ];
}

/** The machine-specific start: nothing for a VPS, create for the two clouds. */
function createSteps(input: CommandInput): Step[] {
  const { target } = input;
  if (target.provider === "gcp") return gcpCreate(target, input.keys.disk);
  if (target.provider === "aws") return awsCreate(target);
  return [];
}

/** The volume: made, opened with a key that arrives on stdin, formatted, mounted. */
function volumeSteps(input: CommandInput, shell: readonly string[]): Step[] {
  const { target, layout } = input;
  const key = `the volume key — made on this machine and kept at ${input.keys.volume} (0600), never written there (D-100 #1, D-111)`;
  const device =
    target.provider === "ssh" ? VPS_CONTAINER : target.provider === "gcp" ? GCP_DATA_DEVICE : "{data-device}";
  const steps: Step[] = [];
  if (target.provider === "ssh") {
    steps.push(
      { what: "make the directory the container file lives in", argv: remote(shell, ["sudo", "mkdir", "-p", "-m", "0700", VPS_CONTAINER_DIR]) },
      { what: `reserve the container file (${input.containerGb} GB)`, argv: remote(shell, ["sudo", "fallocate", "-l", `${input.containerGb}G`, VPS_CONTAINER]) },
    );
  }
  if (target.provider === "aws") {
    steps.push({
      what: "find the data volume: its serial is the EBS volume id, and its device is {data-device}",
      argv: remote(shell, ["lsblk", "-o", "NAME,SERIAL,SIZE"]),
    });
  }
  steps.push(
    { what: "format it as LUKS2, the key arriving on stdin", argv: remote(shell, ["sudo", "cryptsetup", "luksFormat", "--type", "luks2", "--batch-mode", "--key-file", "-", device]), stdin: key },
    { what: "open it, the same way", argv: remote(shell, ["sudo", "cryptsetup", "open", "--key-file", "-", device, MAPPER]), stdin: key },
    { what: "make a filesystem inside it", argv: remote(shell, ["sudo", "mkfs.ext4", "-q", "-L", MAPPER, `/dev/mapper/${MAPPER}`]) },
    { what: "make the mount point", argv: remote(shell, ["sudo", "mkdir", "-p", layout.volume]) },
    { what: "mount it — nothing in fstab or crypttab: the key is not there to use at boot", argv: remote(shell, ["sudo", "mount", `/dev/mapper/${MAPPER}`, layout.volume]) },
  );
  return steps;
}

/** The engine's account, its directories on the volume, and the binary. */
function accountAndBinary(input: CommandInput, reach: Reach): Step[] {
  const { layout } = input;
  const shell = reach.shell;
  return [
    {
      what: `an account for the services (${layout.user}), its home on the volume, no login shell`,
      argv: remote(shell, ["sudo", "useradd", "--system", "--home-dir", layout.home, "--shell", "/usr/sbin/nologin", layout.user]),
    },
    {
      what: "its directories on the volume, readable by it alone",
      argv: remote(shell, [
        "sudo", "install", "-d", "-o", layout.user, "-g", layout.user, "-m", "0700",
        layout.home, layout.stateHome, layout.dataHome, `${layout.volume}/agents`,
      ]),
    },
    { what: "copy the binary over", argv: reach.copy("{binary}", BINARY_UPLOAD) },
    { what: "install it on the boot disk — it is nobody's data", argv: remote(shell, ["sudo", "install", "-m", "0755", BINARY_UPLOAD, layout.binary]) },
    { what: "check it runs, and is this version", argv: remote(shell, [layout.binary, "version"]) },
  ];
}

/** The repository as a bundle, cloned there with no remote, and each copied place as tar. */
function dataSteps(input: CommandInput, shell: readonly string[]): Step[] {
  const { layout } = input;
  const asAgent = ["sudo", "-u", layout.user];
  const bundle = `${layout.agentDir}.bundle`;
  const steps: Step[] = [
    {
      what: "stream the repository — every branch, as a git bundle — straight onto the volume",
      pipeFrom: ["git", "-C", input.agentDir, "bundle", "create", "-", "--all"],
      argv: remote(shell, [...asAgent, "dd", `of=${bundle}`, "status=none"]),
    },
    { what: "clone it there", argv: remote(shell, [...asAgent, "git", "clone", "--quiet", bundle, layout.agentDir]) },
    { what: "with no remote: Mind never creates one (D-013)", argv: remote(shell, [...asAgent, "git", "-C", layout.agentDir, "remote", "remove", "origin"]) },
    { what: "remove the bundle", argv: remote(shell, [...asAgent, "rm", bundle]) },
  ];
  for (const copy of input.copies) {
    steps.push(
      { what: `make the place for ${copy.label}`, argv: remote(shell, [...asAgent, "mkdir", "-p", "-m", "0700", copy.there]) },
      {
        what: `copy ${copy.label}`,
        pipeFrom: ["tar", "-C", copy.here, "-cf", "-", "."],
        argv: remote(shell, [...asAgent, "tar", "-C", copy.there, "-xpf", "-"]),
      },
    );
  }
  return steps;
}

/** .mind/ and the index, made there from what git holds; the units; the tailnet; the check. */
function finishSteps(input: CommandInput, shell: readonly string[]): Step[] {
  const { layout, subject } = input;
  const asAgent = [
    "sudo", "-u", layout.user, "env",
    `HOME=${layout.home}`, `XDG_STATE_HOME=${layout.stateHome}`, `XDG_DATA_HOME=${layout.dataHome}`, layout.binary,
  ];
  const steps: Step[] = [
    { what: "rebuild .mind/ from what git holds (I-2)", argv: remote(shell, [...asAgent, "rebuild", layout.agentDir, "--subject", subject]) },
    {
      what: "build recall there — full-text always, vectors only if bge-m3 and a Qdrant answer there",
      argv: remote(shell, [...asAgent, "memory", "index", layout.agentDir, "--subject", subject]),
    },
  ];
  for (const unit of input.units) {
    steps.push({
      what: `install ${unit.name}`,
      argv: remote(shell, ["sudo", "dd", `of=${unit.path}`, "status=none"]),
      stdin: `the text of ${unit.name}, shown under Services`,
    });
  }
  const enable = input.units.filter((unit) => unit.enable).map((unit) => unit.name);
  steps.push(
    { what: "tell systemd", argv: remote(shell, ["sudo", "systemctl", "daemon-reload"]) },
    { what: "start the page and the timer, and at every boot once the volume is open", argv: remote(shell, ["sudo", "systemctl", "enable", "--now", ...enable]) },
    {
      what: "publish the page to the tailnet — and only the tailnet",
      argv: remote(shell, ["sudo", "tailscale", "serve", "--bg", `--https=${input.webPort}`, `http://127.0.0.1:${input.webPort}`]),
    },
    {
      what: "list what listens: nothing of Mind's on a public address (S13.2 AC2)",
      argv: remote(shell, ["sudo", "ss", "-ltnp"]),
    },
  );
  return steps;
}

/** The release asset that goes to the machine: `mind-linux-<arch>`. */
export function binaryAsset(arch: string): string {
  return assetFor("linux", arch) ?? `mind-linux-${arch}`;
}

/** What each placeholder stands for, for the ones this provider's steps use. */
function placeholdersFor(target: Target, arch: string): Placeholder[] {
  const found: Placeholder[] = [
    {
      name: "{binary}",
      means:
        `${binaryAsset(arch)} of this version, downloaded by Mind at apply time and checked against the ` +
        "release's SHA256SUMS before it is sent",
    },
  ];
  if (target.provider === "aws") {
    found.push(
      { name: "{kms-key-id}", means: "KeyMetadata.KeyId from `aws kms create-key`" },
      { name: "{sg-id}", means: "GroupId from `aws ec2 create-security-group`" },
      { name: "{your-public-ip}", means: "the address this machine reaches the internet from, looked up at apply time — the only one the bootstrap ssh rule admits" },
      { name: "{ssh-public-key}", means: "your ssh public key file, such as ~/.ssh/id_ed25519.pub — the public half only" },
      { name: "{instance-id}", means: "Instances[0].InstanceId from `aws ec2 run-instances`" },
      { name: "{public-dns}", means: "what `aws ec2 describe-instances` answers for the instance's public name" },
      { name: "{data-device}", means: "the NVMe device the EBS volume appears as — the one whose serial is its volume id" },
    );
  }
  return found;
}

/**
 * Once the machine is on the tailnet, the public ssh rule Mind opened goes: from here on it is reached over the
 * tailnet (D-100 #3). Only AWS has a rule of Mind's to take back; a VPS's sshd and GCP's default-allow-ssh are
 * the provider's, and the plan says so rather than changing them.
 */
function closeBootstrapSsh(target: Target): Step[] {
  if (target.provider !== "aws") return [];
  return [
    {
      what: "close the bootstrap ssh rule — the machine is reached over the tailnet from here on",
      argv: ["aws", "ec2", "revoke-security-group-ingress", "--region", target.aws.region, "--group-id", "{sg-id}", "--protocol", "tcp", "--port", "22", "--cidr", "{your-public-ip}/32"],
    },
  ];
}

/** Every command, in the order `apply` would run them. */
export function commandsFor(input: CommandInput): CommandPlan {
  const reach = reachFor(input.target);
  const shell = reach.shell;
  const cpu = input.target.arch === "arm64" ? "aarch64" : "x86_64";
  const steps: Step[] = [
    ...createSteps(input),
    { what: `reach it, and check its CPU is ${cpu} — the binary is built for ${input.target.arch}`, argv: remote(shell, ["uname", "-m"]) },
    { what: "refresh the package lists", argv: remote(shell, ["sudo", "apt-get", "update"]) },
    {
      what: "install what the bootstrap needs: cryptsetup for the volume, git to clone the agent",
      argv: remote(shell, ["sudo", "apt-get", "install", "-y", "--no-install-recommends", "cryptsetup", "git"]),
    },
    { what: "fetch Tailscale's installer", argv: remote(shell, ["curl", "-fsSL", "-o", TAILSCALE_INSTALLER, "https://tailscale.com/install.sh"]) },
    { what: "install Tailscale", argv: remote(shell, ["sudo", "sh", TAILSCALE_INSTALLER]) },
    {
      what: "join your tailnet — it prints a link for you to open; no auth key is written anywhere",
      argv: remote(shell, ["sudo", "tailscale", "up", "--hostname", input.target.name]),
    },
    ...closeBootstrapSsh(input.target),
    ...volumeSteps(input, shell),
    ...accountAndBinary(input, reach),
    ...dataSteps(input, shell),
    ...finishSteps(input, shell),
  ];
  return { steps, placeholders: placeholdersFor(input.target, input.target.arch) };
}
