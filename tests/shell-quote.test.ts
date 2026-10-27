import { describe, expect, test } from "bun:test";
import { shellQuoteCmd, redactCmd } from "../src/runner";

describe("shellQuoteCmd", () => {
  test("plain tokens pass through unquoted", () => {
    expect(
      shellQuoteCmd(["gh", "repo", "view", "x/y", "--json", "description"]),
    ).toBe("gh repo view x/y --json description");
  });

  test("arg containing double quotes survives a bash -c round-trip", () => {
    const argv = [
      "gh",
      "repo",
      "view",
      "x/y",
      "--jq",
      '.description + "|" + "z"',
    ];
    const line = shellQuoteCmd(argv);
    const out = Bun.spawnSync([
      "/bin/bash",
      "-c",
      `set -- ${line}; printf '%s\\n' "$6"`,
    ]);
    expect(out.stdout.toString().trim()).toBe('.description + "|" + "z"');
  });

  test("single-quoted arg survives a bash -c round-trip", () => {
    const argv = ["gh", "api", "--jq", ".a|join(',')"];
    const line = shellQuoteCmd(argv);
    const out = Bun.spawnSync([
      "/bin/bash",
      "-c",
      `set -- ${line}; printf '%s\\n' "$4"`,
    ]);
    expect(out.stdout.toString().trim()).toBe(".a|join(',')");
  });

  test("embedded single quotes are escaped", () => {
    const argv = ["echo", "it's"];
    const line = shellQuoteCmd(argv);
    const out = Bun.spawnSync(["/bin/bash", "-c", `${line}`]);
    expect(out.stdout.toString().trim()).toBe("it's");
  });

  test("dollar expansion is not performed", () => {
    const line = shellQuoteCmd(["echo", "$HOME"]);
    const out = Bun.spawnSync(["/bin/bash", "-c", line]);
    expect(out.stdout.toString().trim()).toBe("$HOME");
  });
});

describe("redactCmd", () => {
  test("still redacts secrets in quoted args", () => {
    expect(redactCmd(["gh", "api", "api_key=sk-123456"])).toBe(
      "gh api api_key=*****",
    );
  });
});
