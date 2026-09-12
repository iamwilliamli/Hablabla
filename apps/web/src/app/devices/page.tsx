import type { Metadata } from "next";
import { DeviceDashboard } from "@/components/devices/dashboard";
import "./devices.css";

export const metadata: Metadata = { title: "Your Mac · Hablabla", description: "Connect your Mac and share a snapshot with your local dashboard." };
export default function DevicesPage() { return <DeviceDashboard />; }
