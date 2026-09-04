"use client";

import { Modal } from "@/components/ui/Modal";
import { ThemeSelector } from "./ThemeSelector";
import { AccentSelector } from "./AccentSelector";

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Appearance"
      description="Choose how ExtensionLab looks. Preferences are saved on this device."
    >
      <div className="space-y-7">
        <ThemeSelector />
        <AccentSelector />
      </div>
    </Modal>
  );
}
