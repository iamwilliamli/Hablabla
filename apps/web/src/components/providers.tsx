"use client";

/**
 * Client boundary for the CopilotKit provider.
 *
 * `@copilotkit/react-core/v2` uses `export *` internally, and Next refuses to
 * pull an `export *` module across a client boundary directly from a Server
 * Component. Importing it inside an explicit `"use client"` module and
 * re-exporting a named component is the fix — layout.tsx stays a Server
 * Component.
 */
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { WebGPUAgent } from "@/lib/local-ai/webgpu-agent";

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/devices") return <>{children}</>;
  if (pathname === "/reference" || pathname === "/voice") {
    return (
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        {children}
      </CopilotKitProvider>
    );
  }
  return <MeetingProvider>{children}</MeetingProvider>;
}

function MeetingProvider({ children }: { children: React.ReactNode }) {
  const [agents] = useState(() => ({ default: new WebGPUAgent() }));
  return (
    <CopilotKitProvider selfManagedAgents={agents} enableInspector={false}>
      {children}
    </CopilotKitProvider>
  );
}
