import type { PageDetail, PageShareInput, PageShareState } from "@rakazo/contracts";
import { PageInputIdSchema, PageShareStateSchema, parsePageShareUrl } from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { NativeSymbol } from "../components/native-symbol";
import { PageLoadFailure } from "../components/pages/page-load-failure";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import {
  clearPageShareView,
  getLatestPage,
  pageReadFailure,
  pageScopeKey,
  privatePageRpc,
  subscribePageScope,
  viewedPageShare,
} from "../lib/pages";

type Visibility = PageShareState["visibility"];
type LinkAction = "copy" | "share" | "open";
type Problem = "read" | "save" | "changed" | LinkAction;
type Ready = {
  status: "ready";
  page: Pick<PageDetail, "title" | "owner" | "version" | "currentVersion">;
  share: PageShareState | null;
};
type Loaded = { status: "loading" } | { status: "error"; error: unknown } | Ready;

function pageShareLink(share: PageShareState | null) {
  if (share?.visibility !== "link" || !share.publishingEnabled) return null;
  const url = parsePageShareUrl(share.shareUrl);
  return url ? { url: url.href, origin: url.origin, generation: share.generation } : null;
}

async function readShare(pageId: string, current: () => boolean) {
  return PageShareStateSchema.parse(await privatePageRpc("pages/getShare", { pageId }, current));
}

/** Keep the link only in the open sheet for this Page and owner. */
export default function PageShareScreen() {
  const params = useLocalSearchParams<{ pageId?: string; viewId?: string }>();
  const scope = useSyncExternalStore(subscribePageScope, pageScopeKey, pageScopeKey);
  const pageId = PageInputIdSchema.safeParse(params.pageId).data;
  const viewId = typeof params.viewId === "string" ? params.viewId : undefined;
  return (
    <PageShareSheet
      key={JSON.stringify([scope, pageId, viewId])}
      scope={scope}
      pageId={pageId}
      viewId={viewId}
    />
  );
}

function PageShareSheet({
  scope,
  pageId,
  viewId,
}: {
  scope: string;
  pageId?: string;
  viewId?: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const navigation = useNavigation();
  const router = useRouter();
  const epoch = useRef(0);
  const operation = useRef<symbol | null>(null);
  const currentLoaded = useRef<Loaded>({ status: "loading" });
  const [loaded, setLoaded] = useState<Loaded>(currentLoaded.current);
  const [attempt, setAttempt] = useState(0);
  const [requiresReview, setRequiresReview] = useState(false);
  const [pending, setPending] = useState<Visibility | "action" | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  function show(next: Loaded) {
    currentLoaded.current = next;
    setLoaded(next);
  }

  function isCurrent(generation: number) {
    return (
      epoch.current === generation &&
      scope === pageScopeKey() &&
      navigation.isFocused() &&
      AppState.currentState === "active"
    );
  }

  useLayoutEffect(() => {
    const hide = () => {
      epoch.current += 1;
      operation.current = null;
      show({ status: "loading" });
      setPending(null);
      setCopied(false);
      setProblem(null);
    };
    const refresh = () => {
      hide();
      const generation = epoch.current;
      const current = () => isCurrent(generation);
      if (!current()) return;
      if (!pageId) {
        show({ status: "error", error: { code: "NOT_FOUND" } });
        return;
      }
      void Promise.all([
        getLatestPage(pageId, { refresh: true }),
        readShare(pageId, current).catch((error: unknown) => {
          if (pageReadFailure(error) === "deleted") throw error;
          return null;
        }),
      ]).then(
        ([page, share]) => {
          if (!current()) return;
          show({ status: "ready", page, share });
          if (!share) setProblem("read");
        },
        (error: unknown) => {
          if (current()) show({ status: "error", error });
        },
      );
    };
    const focus = navigation.addListener("focus", refresh);
    const blur = navigation.addListener("blur", hide);
    const remove = navigation.addListener("beforeRemove", () => {
      clearPageShareView(viewId);
      hide();
    });
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
      else hide();
    });
    refresh();
    return () => {
      epoch.current += 1;
      operation.current = null;
      focus();
      blur();
      remove();
      app.remove();
    };
  }, [attempt, navigation, pageId, scope, viewId]);

  function begin(next: Visibility | "action") {
    const generation = epoch.current;
    if (currentLoaded.current !== loaded || !isCurrent(generation) || operation.current) return;
    const id = Symbol();
    operation.current = id;
    setPending(next);
    setProblem(null);
    if (next !== "action") setCopied(false);
    const current = () => operation.current === id && isCurrent(generation);
    const finish = () => {
      if (!current()) return;
      operation.current = null;
      setPending(null);
    };
    return { current, finish };
  }

  async function save(input: PageShareInput, current: () => boolean, ready: Ready) {
    try {
      const share = PageShareStateSchema.parse(
        await privatePageRpc("pages/setShare", input, current),
      );
      if (current()) show({ ...ready, share });
    } catch (error) {
      if (!current()) return;
      // A lost response may follow a committed write. Read back once before offering another change.
      show({ ...ready, share: null });
      const actual = await readShare(input.pageId, current).catch(() => null);
      if (!current()) return;
      const conflict = (error as { code?: unknown } | null)?.code === "CONFLICT";
      const page =
        input.visibility === "link" && conflict
          ? await getLatestPage(input.pageId, { refresh: true }).catch(() => ready.page)
          : ready.page;
      if (!current()) return;
      show({ ...ready, page, share: actual });
      if (actual?.visibility !== input.visibility) {
        if (input.visibility === "link" && conflict) {
          setRequiresReview(true);
          setProblem("changed");
        } else {
          setProblem("save");
        }
      }
    }
  }

  const viewed = viewedPageShare(pageId, viewId);
  const reviewed =
    loaded.status === "ready" &&
    !requiresReview &&
    viewed?.version === loaded.page.version &&
    viewed.title === loaded.page.title &&
    loaded.page.version === loaded.page.currentVersion
      ? viewed
      : undefined;

  function choose(visibility: Visibility) {
    if (!pageId || loaded.status !== "ready" || loaded.share?.visibility === visibility) return;
    const input: PageShareInput | null =
      visibility === "private"
        ? { pageId, visibility }
        : reviewed && loaded.share?.publishingEnabled
          ? { pageId, visibility, expectedVersion: reviewed.version, expectedTitle: reviewed.title }
          : null;
    if (!input) return;
    const active = begin(visibility);
    if (!active) return;
    let submitted = false;
    const submit = () => {
      if (submitted || !active.current()) return;
      if (input.visibility === "link") {
        const currentView = viewedPageShare(pageId, viewId);
        if (
          currentLoaded.current !== loaded ||
          currentView?.version !== input.expectedVersion ||
          currentView.title !== input.expectedTitle
        ) {
          active.finish();
          return;
        }
      }
      submitted = true;
      void save(input, active.current, loaded).finally(active.finish);
    };
    const cancel = () => {
      if (!submitted) active.finish();
    };
    if (input.visibility === "private") {
      submit();
    } else {
      const audience = t(
        "Anyone with the link can view version {version} and future approved updates.",
        {
          version: input.expectedVersion,
        },
      );
      Alert.alert(
        t("Share this page?"),
        `${input.expectedTitle}\n\n${audience}`,
        [
          { text: t("Cancel"), style: "cancel", onPress: cancel },
          { text: t("Share"), onPress: submit },
        ],
        { cancelable: true, onDismiss: cancel },
      );
    }
  }

  async function openShareLink(action: LinkAction) {
    if (!pageId || loaded.status !== "ready") return;
    const expected = pageShareLink(loaded.share);
    if (!expected) return;
    const active = begin("action");
    if (!active) return;
    if (action === "copy") setCopied(false);
    try {
      const share = await readShare(pageId, active.current);
      if (!active.current()) return;
      show({ ...loaded, share });
      const link = pageShareLink(share);
      if (!link || link.generation !== expected.generation || link.origin !== expected.origin) {
        setCopied(false);
        setProblem("changed");
        return;
      }
      if (action === "copy") {
        if ((await Clipboard.setStringAsync(link.url)) === false) throw new Error("Copy failed");
        if (active.current()) setCopied(true);
      } else if (action === "share") {
        await Share.share(Platform.OS === "ios" ? { url: link.url } : { message: link.url });
      } else {
        await WebBrowser.openBrowserAsync(link.url);
      }
    } catch {
      if (active.current()) {
        // Keep no old link if its fresh lookup could not establish the current generation.
        if (currentLoaded.current === loaded) {
          setCopied(false);
          show({ ...loaded, share: null });
        }
        setProblem(action);
      }
    } finally {
      active.finish();
    }
  }

  const retry = () => {
    if (currentLoaded.current === loaded && isCurrent(epoch.current))
      setAttempt((count) => count + 1);
  };

  if (loaded.status !== "ready") {
    return (
      <View style={styles.center}>
        {loaded.status === "loading" ? (
          <ActivityIndicator color={tokens.mutedForeground} />
        ) : (
          <PageLoadFailure
            error={loaded.error}
            fallback={t("Could not load page sharing.")}
            gone={t("This page isn't available")}
            onRetry={retry}
          />
        )}
      </View>
    );
  }
  const shown = pending === "action" || pending === null ? loaded.share?.visibility : pending;
  const link = pending === null ? pageShareLink(loaded.share) : null;
  const owner = loaded.page.owner;
  const ownerLabel = owner.name.trim() || t("You");
  const checked = (value: Visibility) =>
    shown === value ? (
      <NativeSymbol ios="checkmark" android="checkmark" size={16} color={tokens.foreground} />
    ) : null;
  const message = {
    read: t("Could not load page sharing."),
    save: t("Could not change who can view this page. Try again."),
    changed: t("The page or its link changed. Try again."),
    copy: t("Could not copy the link."),
    share: t("Could not share the link."),
    open: t("Could not open the link."),
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Text numberOfLines={1} style={[styles.heading, { color: tokens.foreground }]}>
        {t("Share “{title}”", { title: loaded.page.title })}
      </Text>
      <SettingsGroup>
        <SettingsRow
          title={ownerLabel}
          value={t("Owner")}
          leading={<Avatar label={ownerLabel} image={owner.image} />}
        />
      </SettingsGroup>
      <SettingsGroup label={t("Who can view")}>
        <SettingsRow
          accessibilityRole="radio"
          accessibilityState={{ checked: shown === "private" }}
          disabled={pending !== null}
          title={t("Only you")}
          leading={
            <NativeSymbol
              ios="lock"
              android="lock-closed-outline"
              size={18}
              color={tokens.foreground}
            />
          }
          trailing={checked("private")}
          onPress={() => choose("private")}
        />
        <SettingsRow
          accessibilityRole="radio"
          accessibilityState={{ checked: shown === "link" }}
          disabled={pending !== null || !loaded.share?.publishingEnabled || !reviewed}
          title={t("Anyone with the link")}
          detail={
            loaded.share?.publishingEnabled === false
              ? t("Link sharing is unavailable")
              : t("No sign-in needed")
          }
          leading={
            <NativeSymbol ios="globe" android="globe-outline" size={18} color={tokens.foreground} />
          }
          trailing={checked("link")}
          onPress={() => choose("link")}
        />
        {loaded.share?.publishingEnabled && loaded.share.visibility === "private" && !reviewed ? (
          <SettingsRow
            accessibilityRole="button"
            title={t("Open current version")}
            detail={t("Review the current version before sharing.")}
            chevron="right"
            onPress={() => {
              if (pageId && currentLoaded.current === loaded && isCurrent(epoch.current))
                router.replace({ pathname: "/page", params: { pageId } });
            }}
          />
        ) : null}
      </SettingsGroup>
      {problem ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: tokens.destructive }]}>
          {message[problem]}
        </Text>
      ) : null}
      {!loaded.share && pending === null ? (
        <SettingsGroup>
          <SettingsRow accessibilityRole="button" title={t("Try again")} onPress={retry} />
        </SettingsGroup>
      ) : null}
      {link ? (
        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            title={t("Copy link")}
            leading={
              <NativeSymbol
                ios={copied ? "checkmark" : "doc.on.doc"}
                android={copied ? "checkmark" : "copy-outline"}
                size={18}
                color={tokens.foreground}
              />
            }
            onPress={() => void openShareLink("copy")}
          />
          <SettingsRow
            accessibilityRole="button"
            title={t("Share")}
            leading={
              <NativeSymbol
                ios="square.and.arrow.up"
                android="share-outline"
                size={18}
                color={tokens.foreground}
              />
            }
            onPress={() => void openShareLink("share")}
          />
          <SettingsRow
            accessibilityRole="button"
            title={t("Open in browser")}
            leading={
              <NativeSymbol
                ios="arrow.up.right"
                android="open-outline"
                size={18}
                color={tokens.foreground}
              />
            }
            onPress={() => void openShareLink("open")}
          />
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function Avatar({ label, image }: { label: string; image: string | null }) {
  const tokens = useMobileTokens();
  return image ? (
    <Image source={{ uri: image }} style={styles.avatar} accessibilityIgnoresInvertColors />
  ) : (
    <View style={[styles.avatar, { backgroundColor: tokens.border }]}>
      <Text style={[styles.initials, { color: tokens.foreground }]}>
        {label.match(/\p{L}/u)?.[0].toLocaleUpperCase() ?? "?"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { paddingTop: 16, paddingBottom: 24 },
  heading: {
    paddingHorizontal: 20,
    paddingBottom: 4,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "500",
    letterSpacing: -0.44,
  },
  error: { paddingHorizontal: 20, fontSize: 12, lineHeight: 16 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  initials: { fontSize: 13, fontWeight: "500" },
});
