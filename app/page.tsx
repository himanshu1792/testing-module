"use client";

import { useState } from "react";
import { FlaskConical, PackagePlus, Play, History } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import AddApplicationTab from "@/app/components/AddApplicationTab";
import RunTestTab from "@/app/components/RunTestTab";
import PreviousRunsTab from "@/app/components/PreviousRunsTab";

type TabId = "add" | "run" | "previous";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "add", label: "Add Application", icon: PackagePlus },
  { id: "run", label: "Run Test", icon: Play },
  { id: "previous", label: "Previous Runs", icon: History },
];

const TAB_INTRO: Record<TabId, { title: string; desc: string }> = {
  add: {
    title: "Applications & repositories",
    desc: "Register a target application and the repository where generated test pull requests are opened.",
  },
  run: {
    title: "Queue a test run",
    desc: "Describe an end-to-end scenario in plain English, or point the explorer at a URL. An AI worker generates Playwright tests and opens a pull request.",
  },
  previous: {
    title: "Run history",
    desc: "Track queued, running, and completed runs, and open the pull request once a run finishes.",
  },
};

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("add");
  const intro = TAB_INTRO[activeTab];

  return (
    <div className="tf-shell">
      <header className="tf-topbar">
        <div className="tf-topbar__inner">
          <div className="tf-brand">
            <span className="tf-brand__mark" aria-hidden="true">
              <FlaskConical size={20} strokeWidth={2.25} />
            </span>
            <span className="tf-brand__text">
              <span className="tf-brand__name">AI Automation Tester</span>
              <span className="tf-brand__tag">
                Autonomous E2E and exploratory QA
              </span>
            </span>
          </div>

          <nav className="tf-tabs" role="tablist" aria-label="Sections">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`tf-tab ${active ? "tf-tab--active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon aria-hidden="true" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="tf-container">
        <div className="tf-pageintro">
          <h1 className="tf-pageintro__title">{intro.title}</h1>
          <p className="tf-pageintro__desc">{intro.desc}</p>
        </div>

        {activeTab === "add" && <AddApplicationTab />}
        {activeTab === "run" && (
          <RunTestTab onQueued={() => setActiveTab("previous")} />
        )}
        {activeTab === "previous" && <PreviousRunsTab />}
      </main>
    </div>
  );
}
