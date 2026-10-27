import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { useConfig } from "@/hooks/use-config";
import { usePolicyStore } from "@/stores/policy-store";
import { useSettingsStore } from "@/stores/settings-store";
import { followUpMenu, type FollowUpMenuSetting } from "@/lib/follow-up-menu";
import { sanitizeBuiltInFollowUpActions } from "@/lib/follow-up-actions";

/**
 * The follow-up actions as the user keeps them (lib/follow-up-menu.ts), with
 * the built-in ones in the current language, and the way to change them.
 * The operator decides which built-in ones show until the user switches
 * them, and whether the user may keep own ones (`ownAllowed`); without, the
 * own ones the user added before are left out.
 */
export function useFollowUpMenu() {
  const t = useTranslations("follow_up");
  const menu = useSettingsStore((s) => s.followUpMenu);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const company = usePolicyStore((s) => s.policy.followUpActions);
  const builtIn = usePolicyStore((s) => s.policy.followUpBuiltInActions);
  const ownAllowed = usePolicyStore((s) => s.isFeatureEnabled("customFollowUpActionsEnabled"));
  const entries = useMemo(
    () => followUpMenu({
      menu: ownAllowed ? menu : { ...menu, own: [] },
      company: company ?? [],
      name: (key) => t(`actions.${key}`),
      builtInShown: sanitizeBuiltInFollowUpActions(builtIn),
    }),
    [menu, company, builtIn, ownAllowed, t],
  );
  return {
    menu,
    entries,
    ownAllowed,
    setMenu: (next: FollowUpMenuSetting) => updateSetting("followUpMenu", next),
  };
}

/** Who the operator's actions come from: the company the login page names, else "Organisation". */
export function useOrganizationName(): string {
  const t = useTranslations("follow_up");
  const { loginCompanyName } = useConfig();
  return loginCompanyName?.trim() || t("menu_organization");
}
