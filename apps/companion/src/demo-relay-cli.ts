import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { DemoRelay } from "./demo-relay.js";
const { values } = parseArgs({ options: { port: { type: "string", default: "3210" } } });
const port = Number(values.port);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port.");
if (!stdin.isTTY) throw new Error("The demo relay requires a Terminal for its local admin controls.");
const relay = new DemoRelay();
const owner = "local-demo-owner";
const terminal = createInterface({ input: stdin, output: stdout });
const help = `Commands: pair | devices | open <device-id> <resource-id> | status
          cancel <command-id> | revoke <device-id> | quit
Tip: with one connected device and one resource, type: Open my presentation
This is a deterministic demo command, not AI understanding. No browser/admin API is exposed.`;
try {
  console.log(`Hablabla loopback demo relay: ${await relay.listen(port)}\n${help}`);
  console.log(`Pairing code (single use, expires in 2 minutes): ${relay.pairing(owner)}`);
  for (;;) {
    const line = (await terminal.question("relay> ")).trim();
    try {
      const [verb, a, b] = line.split(/\s+/);
      if (verb === "quit") break;
      if (verb === "pair") console.log(`Pairing code (2 minutes): ${relay.pairing(owner)}`);
      else if (verb === "devices") console.log(JSON.stringify(relay.list(owner), null, 2));
      else if (verb === "status") console.log(JSON.stringify(relay.history(owner), null, 2));
      else if (verb === "cancel" && a) { relay.cancel(owner, a); console.log("Cancellation requested; check status for the companion result."); }
      else if (verb === "revoke" && a) { relay.revoke(owner, a); console.log("Device revoked."); }
      else if (/^open my presentation\.?$/i.test(line)) {
        const devices = relay.list(owner).filter(d => d.online);
        if (devices.length !== 1 || devices[0]!.resources.length !== 1) throw new Error("Use devices, then open <device-id> <resource-id> to choose the target.");
        const device = devices[0]!;
        console.log(`Queued ${relay.open(owner, device.deviceId, device.resources[0]!.id).commandId}. Approve in the companion Terminal.`);
      } else if (verb === "open" && a && b) console.log(`Queued ${relay.open(owner, a, b).commandId}. Approve in the companion Terminal.`);
      else console.log(help);
    } catch (error) { console.error(error instanceof Error ? error.message : "Request failed."); }
  }
} finally { terminal.close(); await relay.close(); }
