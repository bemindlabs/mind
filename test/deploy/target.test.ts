/**
 * S13.1 — the target file is strict, holds no secrets, and says every problem.
 *
 * Every case below is a file somebody could plausibly write. The ones that
 * matter most are the quiet ones: a misspelt field that would otherwise fall
 * back to a default, a block for the wrong provider, a key pasted into a
 * target, and a host `ssh` would read as an option.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DISK_GB,
  DEFAULT_INSTANCE_TYPE,
  DEFAULT_MACHINE_TYPE,
  formatProblem,
  homeProblem,
  hostProblem,
  isArmType,
  isHostname,
  isIPv6,
  isTailnetAddress,
  parseTarget,
  type TargetParse,
} from "../../src/deploy/target.ts";

const ok = (text: string) => {
  const parsed = parseTarget(text);
  if (!parsed.ok) throw new Error(`expected a target, got ${parsed.problems.map(formatProblem).join("; ")}`);
  return parsed;
};

const problems = (parsed: TargetParse): string[] => (parsed.ok ? [] : parsed.problems.map(formatProblem));
const refused = (value: unknown) => problems(parseTarget(typeof value === "string" ? value : JSON.stringify(value)));

describe("a target that is right", () => {
  test("ssh: the host and the user, and the port defaults to 22", () => {
    const parsed = ok(JSON.stringify({ name: "vps-1", provider: "ssh", ssh: { host: "203.0.113.10", user: "deploy" } }));
    expect(parsed.target).toEqual({
      name: "vps-1",
      provider: "ssh",
      ssh: { host: "203.0.113.10", user: "deploy", port: 22 },
      arch: "x64",
      home: null,
    });
    expect(parsed.defaulted).toEqual(["arch", "ssh.port"]);
  });

  test("gcp: the defaults follow the arch, and a given value is kept", () => {
    const x64 = ok(JSON.stringify({ name: "g", provider: "gcp", gcp: { project: "my-project-1", zone: "asia-southeast1-b" } }));
    expect(x64.target.provider === "gcp" && x64.target.gcp).toEqual({
      project: "my-project-1",
      zone: "asia-southeast1-b",
      machineType: DEFAULT_MACHINE_TYPE.x64,
      diskGb: DEFAULT_DISK_GB,
    });
    expect(x64.defaulted).toEqual(["arch", "gcp.machineType", "gcp.diskGb"]);

    const arm = ok(
      JSON.stringify({ name: "g", provider: "gcp", arch: "arm64", gcp: { project: "my-project-1", zone: "us-central1-a", diskGb: 50 } }),
    );
    expect(arm.target.provider === "gcp" && arm.target.gcp.machineType).toBe(DEFAULT_MACHINE_TYPE.arm64);
    expect(arm.target.provider === "gcp" && arm.target.gcp.diskGb).toBe(50);
    expect(arm.defaulted).toEqual(["gcp.machineType"]);
  });

  test("aws: the defaults follow the arch too", () => {
    const x64 = ok(JSON.stringify({ name: "a", provider: "aws", aws: { region: "ap-southeast-1" } }));
    expect(x64.target.provider === "aws" && x64.target.aws.instanceType).toBe(DEFAULT_INSTANCE_TYPE.x64);
    const arm = ok(JSON.stringify({ name: "a", provider: "aws", arch: "arm64", aws: { region: "eu-central-2", instanceType: "c7gn.large" } }));
    expect(arm.target.provider === "aws" && arm.target.aws).toEqual({ region: "eu-central-2", instanceType: "c7gn.large", diskGb: 20 });
    expect(arm.defaulted).toEqual(["aws.diskGb"]);
  });

  test("home: a MagicDNS name, short or full, or a tailnet address", () => {
    for (const home of ["desk", "desk.tail1234.ts.net", "100.101.102.103", "fd7a:115c:a1e0::1"]) {
      expect(ok(JSON.stringify({ name: "v", provider: "ssh", ssh: { host: "h", user: "u" }, home })).target.home).toBe(home);
    }
  });

  test("an IPv6 host and a tailnet name are hosts", () => {
    for (const host of ["2001:db8::10", "vps.tail1234.ts.net", "example.com", "a"]) {
      expect(ok(JSON.stringify({ name: "v", provider: "ssh", ssh: { host, user: "root", port: 2222 } })).target).toMatchObject({
        ssh: { host, port: 2222 },
      });
    }
  });
});

describe("a target that is wrong says every problem, and which field", () => {
  test("not JSON, and the parser's message is not repeated (it can quote the file)", () => {
    const got = refused(`{ "name": "v", "provider": sk-live-not-json }`);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("is not valid JSON");
    expect(got[0]).not.toContain("sk-live");
  });

  test("not one object", () => {
    expect(refused([])).toEqual(["(file): must be one JSON object"]);
    expect(refused("null")).toEqual(["(file): must be one JSON object"]);
  });

  test("an unknown field is refused at every level, with the fields that exist", () => {
    const got = refused({ name: "v", provider: "ssh", ssh: { host: "h", user: "u", hostname: "x" }, region: "x" });
    expect(got).toContain("region: is not a field here — the fields are name, provider, ssh, gcp, aws, arch, home");
    expect(got).toContain("ssh.hostname: is not a field here — the fields are host, user, port");
    // A misspelt optional is exactly the quiet case: it must not fall back to the default.
    expect(refused({ name: "g", provider: "gcp", gcp: { project: "my-project-1", zone: "us-central1-a", machinetype: "n2-standard-2" } }))
      .toContain("gcp.machinetype: is not a field here — the fields are project, zone, machineType, diskGb");
  });

  test("a field whose name says secret is refused for that reason, and its value is never read into the message", () => {
    const value = "hunter2-correct-horse";
    for (const [where, doc] of [
      ["password", { name: "v", provider: "ssh", ssh: { host: "h", user: "u" }, password: value }],
      ["ssh.privateKey", { name: "v", provider: "ssh", ssh: { host: "h", user: "u", privateKey: value } }],
      ["aws.accessToken", { name: "a", provider: "aws", aws: { region: "us-east-1", accessToken: value } }],
    ] as const) {
      const got = refused(doc);
      const line = got.find((problem) => problem.startsWith(`${where}:`));
      expect(line, `${where} in ${got.join(" | ")}`).toContain("looks like a secret");
      expect(got.join("\n")).not.toContain(value);
    }
  });

  test("a secret pasted into a legitimate field is caught by the guard's scanner, by rule and line", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const text = `{\n  "name": "v",\n  "provider": "ssh",\n  "ssh": { "host": "h", "user": "${token}" }\n}`;
    const got = refused(text);
    const found = got.find((problem) => problem.includes("rule github-token"));
    expect(found).toBe(
      "(file): line 4 holds a GitHub token (rule github-token). A target file holds no secrets; move it out, and rotate it if this file was ever shared",
    );
    expect(got.join("\n")).not.toContain(token);
    // The field it sat in is still named — without the value, which is the
    // token. Found by this test: the first version quoted it right back.
    expect(got).toContain("ssh.user: the value is not a user name (letters, digits, _ . -, not starting with - or a digit)");
    // And a private key anywhere at all.
    expect(refused(`{"name":"v","provider":"ssh","ssh":{"host":"h","user":"u"},"arch":"-----BEGIN OPENSSH PRIVATE KEY-----"}`).join("\n"))
      .toContain("rule pem-private-key");
  });

  test("the provider block must match the provider, and be there", () => {
    expect(refused({ name: "v", provider: "ssh", ssh: { host: "h", user: "u" }, gcp: { project: "p" } }))
      .toContain("gcp: is given, and the provider is ssh — one target, one provider");
    expect(refused({ name: "v", provider: "gcp" })).toContain("gcp: is required for provider gcp");
    expect(refused({ name: "v", provider: "aws", aws: "ap-southeast-1" })).toContain("aws: must be an object");
    expect(refused({ name: "v", aws: {} })).toEqual(["provider: is required", "aws: is given, and provider is not"]);
    expect(refused({ name: "v", provider: "azure" })).toContain(`provider: "azure" is not one of ssh, gcp, aws`);
  });

  test("names, types and ranges", () => {
    const got = refused({ name: "Not_A_Name", provider: "ssh", arch: "riscv", ssh: { host: 7, port: 70000 } });
    expect(got).toContain(`name: "Not_A_Name" is not a machine name (a-z, 0-9 and -, starting with a letter, 63 at most)`);
    expect(got).toContain(`arch: "riscv" is not one of x64, arm64`);
    expect(got).toContain("ssh.host: must be a string");
    expect(got).toContain("ssh.user: is required");
    expect(got).toContain("ssh.port: must be a whole number from 1 to 65535");
    // The block is still read when the name is wrong, so one run names both.
    expect(got.length).toBe(5);

    expect(refused({ name: "g", provider: "gcp", gcp: { project: "P", zone: "asia", diskGb: 5 } })).toEqual([
      `gcp.project: "P" is not a GCP project id (6–30 characters: a-z, 0-9, -)`,
      `gcp.zone: "asia" is not a GCP zone, such as asia-southeast1-b`,
      "gcp.diskGb: must be a whole number from 10 to 4096",
    ]);
    expect(refused({ name: "a", provider: "aws", aws: { region: "Tokyo", instanceType: "big", diskGb: 12.5 } })).toEqual([
      `aws.region: "Tokyo" is not an AWS region, such as ap-southeast-1`,
      `aws.instanceType: "big" is not an EC2 instance type, such as t3.small`,
      "aws.diskGb: must be a whole number from 10 to 4096",
    ]);
    expect(refused({ name: "g", provider: "gcp", gcp: { project: "my-project-1", zone: "us-central1-a", machineType: "e2" } }))
      .toEqual([`gcp.machineType: "e2" is not a GCP machine type, such as e2-small`]);
    expect(refused({ name: "v", provider: "ssh", ssh: { host: "h", user: "u" }, home: 1 })).toEqual(["home: must be a string"]);
  });

  test("a host ssh would read as an option, or with the user in it, is refused", () => {
    expect(refused({ name: "v", provider: "ssh", ssh: { host: "-oProxyCommand=touch /tmp/x", user: "u" } }))
      .toEqual([`ssh.host: "-oProxyCommand=touch /tmp/x" is not a host name or an IP address`]);
    expect(refused({ name: "v", provider: "ssh", ssh: { host: "root@vps", user: "u" } }))
      .toEqual([`ssh.host: "root@vps" holds an @ — the user goes in \`ssh.user\`, the host alone here`]);
    expect(refused({ name: "v", provider: "ssh", ssh: { host: "h", user: "-l" } })[0]).toContain("is not a user name");
  });

  test("the arch has to agree with the machine type, both ways round", () => {
    expect(refused({ name: "g", provider: "gcp", gcp: { project: "my-project-1", zone: "us-central1-a", machineType: "t2a-standard-2" } }))
      .toEqual([`gcp.machineType: "t2a-standard-2" is an Arm type — set arch to arm64 (it defaults to x64)`]);
    expect(refused({ name: "a", provider: "aws", arch: "x64", aws: { region: "us-east-1", instanceType: "m7g.large" } }))
      .toEqual([`aws.instanceType: "m7g.large" is an Arm type and arch is x64 — set arch to arm64, or pick an x64 type`]);
    expect(refused({ name: "a", provider: "aws", arch: "arm64", aws: { region: "us-east-1", instanceType: "g5.xlarge" } })[0])
      .toContain("is not an Arm type this plan knows (Graviton types such as t4g, m7g, c7gn), and arch is arm64");
    expect(refused({ name: "g", provider: "gcp", arch: "arm64", gcp: { project: "my-project-1", zone: "us-central1-a", machineType: "n2-standard-2" } })[0])
      .toContain("(t2a, c4a, n4a)");
  });

  test("home outside the tailnet is refused: a public address, or a name that is not MagicDNS", () => {
    const base = { name: "v", provider: "ssh", ssh: { host: "h", user: "u" } };
    expect(refused({ ...base, home: "203.0.113.5" })[0]).toContain("is an address outside the tailnet");
    expect(refused({ ...base, home: "2001:db8::1" })[0]).toContain("is an address outside the tailnet");
    expect(refused({ ...base, home: "home.example.com" })[0]).toContain("is a name outside the tailnet");
    expect(refused({ ...base, home: "not a host" })[0]).toContain("is not a host name");
  });
});

describe("the small predicates", () => {
  test("addresses and names", () => {
    expect(isIPv6("2001:db8::1")).toBe(true);
    expect(isIPv6("::1")).toBe(true);
    expect(isIPv6("1.2.3.4")).toBe(false);
    expect(isIPv6("2001:db8:::1:2:3:4:5:6:7")).toBe(false);
    expect(isHostname("a.b.c")).toBe(true);
    expect(isHostname("vps.")).toBe(true);
    expect(isHostname("")).toBe(false);
    expect(isHostname("x".repeat(254))).toBe(false);
    expect(isHostname("1.2.3.999")).toBe(false);
    expect(isHostname("-lead.example")).toBe(false);
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("10.0.0.1")).toBe(false);
    expect(isTailnetAddress("fd7a:115c:a1e0:ab12::1")).toBe(true);
    expect(isTailnetAddress("fd00::1")).toBe(false);
    expect(hostProblem("vps-1")).toBeUndefined();
    expect(homeProblem("desk")).toBeUndefined();
  });

  test("which machine types are Arm", () => {
    for (const type of ["t4g.small", "m7gd.large", "c7gn.16xlarge", "a1.medium", "im4gn.large", "r8g.xlarge"]) {
      expect(isArmType("aws", type), type).toBe(true);
    }
    for (const type of ["t3.small", "g5.xlarge", "c6in.large", "m7i-flex.large", "p4d.24xlarge"]) {
      expect(isArmType("aws", type), type).toBe(false);
    }
    expect(isArmType("gcp", "t2a-standard-1")).toBe(true);
    expect(isArmType("gcp", "c4a-highcpu-4")).toBe(true);
    expect(isArmType("gcp", "e2-small")).toBe(false);
  });
});
