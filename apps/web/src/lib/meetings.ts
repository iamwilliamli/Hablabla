export type Meeting = {
  id: string;
  title: string;
  date: string;
  time: string;
  duration: string;
  category: string;
  participants: string[];
  transcript: string;
  sample: boolean;
};

export const sampleMeetings: Meeting[] = [
  {
    id: "MTG-launch",
    title: "Let's make launch feel effortless.",
    date: "September 12, 2026",
    time: "10:00 AM",
    duration: "32 min",
    category: "Product & design",
    participants: ["Maya Chen", "Alex Rivera", "Sam Taylor"],
    sample: true,
    transcript: `Maya Chen [00:00]: Let's align on the launch experience. The goal is a smaller, calmer onboarding flow that helps people get to their first useful result.

Alex Rivera [02:14]: The five-step setup feels like too much. I suggest we start with a workspace name and let people invite teammates later.

Maya Chen [04:32]: Agreed. We'll launch with a two-step onboarding flow. Team invites will be optional and available from the workspace.

Sam Taylor [08:05]: I can update the onboarding screens by Tuesday, September 15. I'll include the empty states and keyboard focus behavior.

Alex Rivera [12:40]: I'll run five usability sessions by Thursday, September 17, and share the findings in our next review.

Maya Chen [18:12]: Before we commit to a launch date, we need to decide who owns the help content. That still doesn't have an owner.

Sam Taylor [24:08]: Let's keep the pricing page out of this release. It deserves its own review.

Maya Chen [30:15]: Yes, pricing stays out of scope. Our next check-in is Friday. Let's use that time to review the usability findings and agree on the launch date.`,
  },
  {
    id: "MTG-research",
    title: "A little closer to our customers.",
    date: "September 11, 2026",
    time: "2:30 PM",
    duration: "24 min",
    category: "Customer research",
    participants: ["Alex Rivera", "Jordan Lee"],
    sample: true,
    transcript: `Alex Rivera [00:00]: Three customers said they couldn't tell whether their changes were saved. We should make that feedback clearer.

Jordan Lee [06:15]: Let's add a visible saved state, with a timestamp and a screen-reader announcement.

Alex Rivera [10:20]: Agreed. I'll document the feedback and share the customer quotes by Monday, September 14.

Jordan Lee [16:30]: I'll prototype the saved indicator by Wednesday, September 16. We still need to choose someone to test it with assistive technology.

Alex Rivera [23:00]: We'll review the prototype on Thursday. We haven't decided whether the indicator belongs in the header or next to the form.`,
  },
  {
    id: "MTG-weekly",
    title: "Small steps. A good week ahead.",
    date: "September 10, 2026",
    time: "9:00 AM",
    duration: "18 min",
    category: "Team check-in",
    participants: ["Maya Chen", "Sam Taylor", "Jordan Lee"],
    sample: true,
    transcript: `Maya Chen [00:00]: This week we should focus on reliability and finish the work already in progress.

Sam Taylor [04:10]: I'll fix the narrow-screen navigation issue by Friday, September 11.

Jordan Lee [08:20]: I'll review the error messages by Monday, September 14. Some of them don't explain how to recover.

Maya Chen [12:30]: Let's pause new feature work until the existing issues are resolved. That's our decision for this week.

Sam Taylor [17:00]: We still need to decide how to measure whether the new navigation is easier to use.`,
  },
];

export function transcriptEntries(transcript: string) {
  return transcript
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((paragraph, index) => {
      const match = paragraph.match(
        /^([^\n:]+?)\s*\[(\d{1,2}:\d{2})\]:\s*([\s\S]*)$/,
      );
      return {
        id: index,
        speaker: match?.[1] ?? "Transcript",
        time: match?.[2] ?? "",
        text: match?.[3] ?? paragraph,
      };
    });
}

export function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
}
