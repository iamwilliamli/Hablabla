import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function demoCertificate(directory: string, addresses: string[], hostname: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, "server-key.pem"), certPath = join(directory, "server-cert.pem");
  const names = [...new Set(["localhost", hostname])];
  const config = `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=Hablabla Speech Lab\n[extensions]\nsubjectAltName=@names\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n[names]\n${names.map((name,i) => `DNS.${i + 1}=${name}`).join("\n")}\n${addresses.map((address,i) => `IP.${i + 1}=${address}`).join("\n")}\n`;
  const configPath = join(directory, "openssl.cnf");
  let previous = "";
  try { previous = await readFile(configPath,"utf8"); } catch {}
  let reuse = previous === config;
  if (reuse) {
    const checked = spawnSync("openssl",["x509","-checkend","86400","-noout","-in",certPath]);
    try { await readFile(keyPath); reuse = checked.status === 0; } catch { reuse = false; }
  }
  if (!reuse) {
    await writeFile(configPath, config, { mode: 0o600 });
    const result = spawnSync("openssl", ["req","-x509","-newkey","rsa:2048","-nodes","-days","30","-keyout",keyPath,"-out",certPath,"-config",configPath], {encoding:"utf8"});
    if (result.status !== 0) throw new Error("Could not create a local HTTPS certificate using openssl.");
    await chmod(keyPath,0o600);
  }
  return {key:await readFile(keyPath),cert:await readFile(certPath)};
}
