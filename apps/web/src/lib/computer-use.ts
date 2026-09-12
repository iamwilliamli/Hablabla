import { z } from "zod";
import { controlActionSchema, type ControlAction } from "./devices-protocol";

export const computerProposalSchema = z.strictObject({
  planId: z.uuid(), deviceId: z.uuid(), catalogId: z.uuid(), windowId: z.uuid(),
  expiresAt: z.iso.datetime(), model: z.string().min(1).max(100),
  message: z.string().max(2000), action: controlActionSchema.nullable(),
});
export type ComputerProposal = z.infer<typeof computerProposalSchema>;

export function describeControl(action: ControlAction): string {
  const point = (p: { x: number; y: number }) => `${Math.round(p.x * 100)}% from left, ${Math.round(p.y * 100)}% from top`;
  switch (action.kind) {
    case "activate_window": return "Bring this window to the front";
    case "type_text": return `Type: ${action.text}`;
    case "key": return `Press ${[...action.modifiers, action.key].join(" + ")}`;
    case "scroll": return `Scroll at ${point(action.point)}: horizontal ${action.dx}px, vertical ${action.dy}px`;
    case "pointer": return `${({ move: "Move pointer", click: "Click", double_click: "Double-click", right_click: "Right-click", drag: "Drag" })[action.mode]} at ${point(action.point)}${action.end ? ` to ${point(action.end)}` : ""}`;
  }
}
