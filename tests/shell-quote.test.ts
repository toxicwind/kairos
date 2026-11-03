import { describe, expect, test } from "bun:test";
import { shellQuoteCmd, redactCmd, segmentsToCmd } from "../src/quote.ts";

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
  test("redacts Authorization header", () => {
    expect(redactCmd(["curl", "-H", "Authorization: Bearer abc123def"])).toContain(
      "Authorization: *****",
    );
    expect(redactCmd(["curl", "-H", "Authorization: Bearer abc123def"])).not.toContain(
      "abc123def",
    );
  });
  test("redacts bare key tokens", () => {
    expect(redactCmd(["gh", "api", "sk-abcdef123"])).toContain("*****");
  });
  test("redacts KEY=value forms", () => {
    expect(redactCmd(["env", "TOKEN=supersecret", "cmd"])).toContain(
      "TOKEN=*****",
    );
  });
  test("caps at 8 args", () => {
    const out = redactCmd(Array(20).fill("a"));
    expect(out.split(" ").length).toBeLessThanOrEqual(8);
  });
});

describe("segmentsToCmd", () => {
  test("joins segments with ops", () => {
    expect(segmentsToCmd([["ls"], ["grep", "x"]], ["|"])).toBe("ls | grep x");
    expect(
      segmentsToCmd([["git", "add", "."], ["git", "commit"]], ["&&"]),
    ).toBe("git add . && git commit");
  });
  test("defaults op to pipe", () => {
    expect(segmentsToCmd([["a"], ["b"]])).toBe("a | b");
  });
  test("empty segments returns true", () => {
    expect(segmentsToCmd([], [])).toBe("true");
  });
  test("quotes args with spaces", () => {
    expect(segmentsToCmd([["echo", "hello world"]])).toBe("echo 'hello world'");
  });
});
