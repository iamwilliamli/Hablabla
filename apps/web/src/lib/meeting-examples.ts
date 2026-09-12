import type { MeetingResult } from "./local-ai/result-schema";

// Authored examples, explicitly labeled in the UI. Replaced only by validated local output.
export const exampleRecaps: Record<string, MeetingResult> = {
  "MTG-launch": {
    summary:
      "A simpler first impression, with room to grow. The team aligned on two-step onboarding, made space for usability testing, and kept pricing out of this release. Help content still needs an owner before a launch date is set.",
    decisions: [
      {
        text: "Keep onboarding to two simple steps",
        evidence: "We'll launch with a two-step onboarding flow.",
      },
      {
        text: "Make team invitations optional",
        evidence:
          "Team invites will be optional and available from the workspace.",
      },
      {
        text: "Save the pricing page for a future release",
        evidence: "Yes, pricing stays out of scope.",
      },
    ],
    actions: [
      {
        title: "Bring the new onboarding flow to life",
        description:
          "Update the onboarding screens, including empty states and keyboard focus behavior.",
        owner: "Sam Taylor",
        due: "Sep 15, 2026",
        evidence:
          "I can update the onboarding screens by Tuesday, September 15.",
      },
      {
        title: "Put the experience in front of five people",
        description:
          "Run five usability sessions and share the findings in the next review.",
        owner: "Alex Rivera",
        due: "Sep 17, 2026",
        evidence:
          "I'll run five usability sessions by Thursday, September 17, and share the findings in our next review.",
      },
      {
        title: "Find an owner for the help content",
        description:
          "Agree on who will own the help content before committing to a launch date.",
        owner: "Unassigned",
        due: "Not set",
        evidence:
          "Before we commit to a launch date, we need to decide who owns the help content.",
      },
    ],
    questions: [
      "Who will own the help content?",
      "What launch date can we commit to after usability testing?",
    ],
  },
};
