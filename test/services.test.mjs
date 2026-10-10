import { isValidAction, isValidUnit, parseUnitFileStates, parseUnitsPlain } from "../src/services.js";
import { eq, ok, summary, test } from "./harness.mjs";

console.log("services");

test("单元名白名单接受正常单元", () => {
  const good = ["ssh.service", "cron.service", "user@1000.service", "systemd-udevd.service", "apt-daily-upgrade.service", "a@b-c_d.service"];
  for (const unit of good) ok(isValidUnit(unit), `应接受 ${unit}`);
});

test("单元名白名单挡掉注入与畸形名", () => {
  const bad = [
    "sshd",
    "--now",
    "cron.service; rm -rf /",
    "cron.service\nrm -rf /",
    "cron.service && id",
    "../../etc/passwd",
    "a/b.service",
    " cron.service",
    "cron.service ",
    "-x.service",
    "cron.service'",
    'cron.service"',
    "cron.service$(id)",
    "cron.service`id`",
    "",
    null,
    undefined,
    123,
    "x".repeat(200) + ".service",
  ];
  for (const unit of bad) ok(!isValidUnit(unit), `应拒绝 ${JSON.stringify(unit)}`);
});

test("动作是枚举表，表外一律拒绝", () => {
  for (const action of ["start", "stop", "restart", "reload", "enable", "disable"]) ok(isValidAction(action), action);
  for (const action of ["kill", "START", "start; rm", "__proto__", "toString", "", null]) {
    ok(!isValidAction(action), `应拒绝 ${JSON.stringify(action)}`);
  }
});

test("parseUnitsPlain 解析旧版文本输出", () => {
  const text = [
    "ssh.service      loaded active running OpenBSD Secure Shell server",
    "cron.service     loaded active running Regular background program processing daemon",
    "avahi-daemon.service loaded active running Avahi mDNS/DNS-SD Stack",
  ].join("\n");
  const rows = parseUnitsPlain(text);
  eq(rows.length, 3);
  eq(rows[0].unit, "ssh.service");
  eq(rows[0].description, "OpenBSD Secure Shell server");
  eq(rows[1].sub, "running");
});

test("parseUnitFileStates 把 vendor preset 等状态映射成 true/false/null", () => {
  const text = [
    "anacron.service              enabled         enabled",
    "apt-daily.service            static          -",
    "bluetooth.service            disabled        enabled",
    "console-setup.service        masked          enabled",
  ].join("\n");
  const map = parseUnitFileStates(text);
  eq(map.get("anacron.service"), true);
  eq(map.get("apt-daily.service"), null);
  eq(map.get("bluetooth.service"), false);
  eq(map.get("console-setup.service"), false);
});

summary();
