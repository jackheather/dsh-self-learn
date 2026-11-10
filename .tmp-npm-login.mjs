// npm 的 web 登录会先打印一个 URL，然后等浏览器完成授权后轮询 registry 拿 token。
// 在非交互环境里 stdin 一关，npm 就退回 "Username:" 提示并退出——所以这里保持 stdin 打开。
import { spawn } from "node:child_process";

const p = spawn("cmd", ["/c", "npm login --auth-type=web"], {
  cwd: "D:/工作/dsh-workspace/plugins/dsh-self-learn",
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

p.stdout.on("data", (d) => process.stdout.write(d));
p.stderr.on("data", (d) => process.stdout.write(d));
p.on("exit", (code) => {
  console.log(`\n[npm-login] exited ${code}`);
  process.exit(code ?? 1);
});

// 保活：不关闭 stdin，也不让进程因为事件循环空掉而退出
setInterval(() => {}, 60_000);
