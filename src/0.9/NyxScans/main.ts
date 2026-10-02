import {
    BasicRateLimiter,
    Chapter,
    ChapterDetails,
    ChapterProviding,
    CloudflareError,
    ContentRating,
    DiscoverSection,
    DiscoverSectionItem,
    DiscoverSectionProviding,
    DiscoverSectionType,
    Extension,
    Form,
    MangaProviding,
    Metadata,
    PagedResults,
    PaperbackInterceptor,
    Request,
    Response,
    SearchQuery,
    SearchResultItem,
    SearchResultsProviding,
    Section,
    SettingsFormProviding,
    SourceManga,
    Tag,
    TagSection,
    ToggleRow,
} from "@paperback/types";

import * as cheerio from "cheerio";

// URLs base
const WEB_URL = "https://nyxscans.com";
const API_URL = "https://api.nyxscans.com";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";
const CLOUDFLARE_RE = /_cf_chl_opt|challenge-platform|cf-turnstile|Just a moment/i;

// Caché del HTML de /series/{slug} y del home (varias llamadas seguidas lo reutilizan)
const PAGE_CACHE_TTL = 60_000;
const PAGE_CACHE_MAX = 30;

// Secciones del home: clave del estado embebido → sección de discover.
// `todayPosts` viene envuelto en {data:{posts:[...]}}, el resto son arrays.
const HOME_SECTIONS: { key: string; title: string; type: DiscoverSectionType }[] = [
    { key: "combinedSliderPosts", title: "Featured", type: DiscoverSectionType.featured },
    { key: "todayPosts", title: "Popular Today", type: DiscoverSectionType.prominentCarousel },
    { key: "latestMangaPosts", title: "Latest Releases", type: DiscoverSectionType.simpleCarousel },
    { key: "weeklyPosts", title: "Popular This Week", type: DiscoverSectionType.simpleCarousel },
    { key: "monthlyPosts", title: "Popular This Month", type: DiscoverSectionType.simpleCarousel },
];
// Otras claves del estado que delimitan el final de una sección
// (firstHeroImageSrc va justo después del slider, que es la última).
const HOME_OTHER_KEYS = ["latestNovelPosts", "publishedCollections", "firstHeroImageSrc"];

// --- NSFW (+18) setting ---
// Series are flagged via genres (Adult / Mature / Ecchi...). Defaults to the
// app profile's adult-content preference; overridable in the extension settings.
const NSFW_STATE_KEY = "nyxscans.showNsfw";
const ADULT_GENRE_RE = /adult|mature|ecchi|smut|hentai|nsfw/i;

function getShowNsfw(): boolean {
    const v = Application.getState(NSFW_STATE_KEY);
    if (typeof v === "boolean") return v;
    try {
        return typeof Application.filterAdultTitles === "boolean" ? !Application.filterAdultTitles : true;
    } catch {
        return true;
    }
}

class NyxScansSettingsForm extends Form {
    private showNsfw = getShowNsfw();

    async updateShowNsfw(value: boolean): Promise<void> {
        this.showNsfw = value;
        Application.setState(value, NSFW_STATE_KEY);
        this.reloadForm();
    }

    override getSections() {
        return [
            Section(
                {
                    id: "content",
                    footer: "Hides series tagged with adult genres (Adult, Mature, Ecchi...) from search and the discover sections.",
                },
                [
                    ToggleRow("show_nsfw", {
                        title: "Show NSFW content (18+)",
                        value: this.showNsfw,
                        onValueChange: Application.Selector<
                            NyxScansSettingsForm,
                            (value: boolean) => Promise<void>
                        >(this, "updateShowNsfw"),
                    }),
                ],
            ),
        ];
    }
}

class NyxScansInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            ...request.headers,
            referer: `${WEB_URL}/`,
            origin: WEB_URL,
            "user-agent": await Application.getDefaultUserAgent(),
            accept: "*/*",
        };
        return request;
    }

    override async interceptResponse(
        _request: Request,
        _response: Response,
        data: ArrayBuffer,
    ): Promise<ArrayBuffer> {
        return data;
    }
}

type NyxScansImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding &
    SettingsFormProviding;

// Capítulo tal como lo devuelve /api/chapters?postId=N
type ApiChapter = {
    id?: number;
    slug?: string;
    number?: number | string;
    title?: string | null;
    createdAt?: string;
    isLocked?: boolean;
    isAccessible?: boolean;
};

type HomeTile = { mangaId: string; title: string; imageUrl: string; isAdult: boolean };

export class NyxScansExtension implements NyxScansImplementation {
    requestManager = new NyxScansInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 3,
        bufferInterval: 1,
        ignoreImages: true,
    });

    private pageCache = new Map<string, { data: string; expiry: number }>();

    async initialise(): Promise<void> {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
    }

    async getSettingsForm(): Promise<Form> {
        return new NyxScansSettingsForm();
    }

    // ---- fetch helpers ----

    private async fetchText(url: string): Promise<string> {
        const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
        const body = Application.arrayBufferToUTF8String(data);
        const blocked = response.status === 403 || response.status === 503 || response.status === 429;
        if (blocked && CLOUDFLARE_RE.test(body.slice(0, 20_000))) {
            throw new CloudflareError(
                { url: `${WEB_URL}/`, method: "GET" },
                "Cloudflare challenge on nyxscans.com: open the site in the browser to verify, then retry.",
            );
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Nyx Scans request failed (HTTP ${response.status}): ${url}`);
        }
        return body;
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const text = await this.fetchText(url);
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new Error(`Nyx Scans returned invalid JSON: ${url}`);
        }
    }

    // HTML de una página con el estado embebido ya normalizado (ver stripRefs).
    private async getPageState(path: string): Promise<string> {
        const now = Date.now();
        const cached = this.pageCache.get(path);
        if (cached && cached.expiry > now) return cached.data;

        const data = this.stripRefs(await this.fetchText(`${WEB_URL}${path}`));
        if (this.pageCache.size >= PAGE_CACHE_MAX) this.pageCache.clear();
        this.pageCache.set(path, { data, expiry: now + PAGE_CACHE_TTL });
        return data;
    }

    private getSeriesHTML(mangaId: string): Promise<string> {
        return this.getPageState(`/series/${this.pathSegment(mangaId)}`);
    }

    // ---- utils ----

    // El sitio embebe su estado como un objeto JS serializado con Seroval:
    // claves sin comillas, `!0`/`!1` como booleanos y una asignación de
    // referencia `$R[n]=` delante de cada objeto/array. Quitándolas queda un
    // literal plano donde `key:"valor"` y `key:[...]` se extraen con regex.
    private stripRefs(html: string): string {
        return html.replace(/\$R\[\d+\]=/g, "");
    }

    // Cadenas del estado: escapes JS (Seroval emite `<` como \x3C) y, después,
    // entidades HTML que vengan del propio contenido.
    private decodeString(text: string): string {
        const unescaped = (text || "").replace(
            /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
            (_m, esc: string) => {
                if (esc[0] === "u") return String.fromCodePoint(parseInt(esc.replace(/[u{}]/g, ""), 16));
                if (esc[0] === "x") return String.fromCharCode(parseInt(esc.slice(1), 16));
                if (esc === "n") return "\n";
                if (esc === "r") return "";
                if (esc === "t") return " ";
                return esc;
            },
        );
        return this.decodeEntities(unescaped);
    }

    private decodeEntities(text: string): string {
        return (text || "")
            .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&");
    }

    // postContent es HTML enriquecido (<p>, <br>, <strong>...); se aplana a
    // texto conservando los saltos de párrafo.
    private htmlToText(html: string): string {
        return html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p\s*>/gi, "\n\n")
            .replace(/<\/?[a-z][^>]*>/gi, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    // Primer `key:"valor"` dentro de un bloque del estado (ya sin $R[n]=).
    private strField(block: string, key: string): string | undefined {
        const m = new RegExp(`[{,]${key}:"((?:\\\\.|[^"\\\\])*)"`).exec(block);
        return m ? this.decodeString(m[1] ?? "") : undefined;
    }

    private numField(block: string, key: string): number | undefined {
        const m = new RegExp(`[{,]${key}:(-?[\\d.]+)`).exec(block);
        const n = m ? parseFloat(m[1] ?? "") : NaN;
        return Number.isFinite(n) ? n : undefined;
    }

    // Nombres del primer `genres:[{id:N,name:"..."},...]` del bloque.
    private genreNames(block: string): string[] {
        const start = block.indexOf("genres:[");
        if (start === -1) return [];
        const end = block.indexOf("]", start);
        const list = block.slice(start, end === -1 ? start + 3000 : end);
        const names: string[] = [];
        const re = /name:"((?:\\.|[^"\\])*)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(list)) !== null) {
            const label = this.decodeString(m[1] ?? "").trim();
            if (label) names.push(label);
            if (names.length >= 25) break;
        }
        return names;
    }

    private mapStatus(statusText: string): string {
        const s = (statusText || "").toUpperCase();
        if (s.includes("COMPLETED") || s.includes("ENDED") || s.includes("FINISHED")) return "Completed";
        if (s.includes("HIATUS") || s.includes("PAUSED")) return "Hiatus";
        if (s.includes("CANCEL") || s.includes("DROPPED")) return "Cancelled";
        return "Ongoing";
    }

    // Los IDs en 0.9 solo admiten alfanuméricos y `._-@()[]%?#+=/&:`. Algunos slugs
    // traen apóstrofes (barbarian's-adventure...) → se percent-encodean (%27). El
    // sitio acepta el slug encodeado en la URL, así que no hace falta decodificar.
    private toSafeId(id: string): string {
        return id.replace(/[^A-Za-z0-9._\-@()[\]%?#+=/&:]/g, (c) => {
            const enc = encodeURIComponent(c);
            if (enc !== c) return enc;
            return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        });
    }

    // Los ids acaban en rutas: decodificados no pueden salirse del segmento
    // (/, \, ?, #, .., caracteres de control) y se vuelven a encodear.
    private pathSegment(id: string): string {
        const slug = this.slugFromId(id);
        if (!slug || slug === "." || slug.length > 300 || /[/\\?#\u0000-\u001f\u007f]|\.\./.test(slug)) {
            throw new Error(`Invalid Nyx Scans id: ${id}`);
        }
        return encodeURIComponent(slug);
    }

    private httpsOr(url: string | undefined, fallback: string): string {
        const u = (url || "").trim();
        return u.startsWith("https://") ? u : fallback;
    }

    private isNovel(seriesType: unknown, novelFlag: unknown): boolean {
        return novelFlag === true || String(seriesType || "").toUpperCase() === "NOVEL";
    }

    private slugFromId(mangaId: string): string {
        try {
            return decodeURIComponent(mangaId);
        } catch {
            return mangaId;
        }
    }

    private escapeRegExp(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // Bloque `post:{id:N,slug:"<slug>",...}` de la serie dentro del estado.
    // Devuelve el id numérico del post (necesario para /api/chapters) y el bloque.
    private findSeriesPost(data: string, mangaId: string): { id?: number; block: string } {
        const slug = this.escapeRegExp(this.slugFromId(mangaId));
        let m = new RegExp(`post:\\{id:(\\d+),slug:"${slug}"`, "i").exec(data);
        if (!m) m = /post:\{id:(\d+),slug:"/.exec(data);
        if (!m) return { block: "" };

        const start = m.index;
        // El objeto de la serie termina donde empieza la lista inicial de capítulos.
        let end = data.indexOf(",initialChapters:", start);
        if (end === -1 || end - start > 60_000) end = Math.min(data.length, start + 60_000);
        return { id: parseInt(m[1] ?? "", 10) || undefined, block: data.slice(start, end) };
    }

    private postIsAdult(post: any): boolean {
        return Array.isArray(post?.genres) && post.genres.some((g: any) => ADULT_GENRE_RE.test(g?.name || ""));
    }

    private searchItemFromPost(post: any): SearchResultItem | undefined {
        const id = post?.slug;
        const title = post?.postTitle;
        if (typeof id !== "string" || typeof title !== "string" || !id || !title) return undefined;
        if (this.isNovel(post?.seriesType, post?.isNovel)) return undefined;
        const image = this.httpsOr(post?.featuredImage, FALLBACK_COVER);
        return {
            mangaId: this.toSafeId(id),
            title,
            imageUrl: image,
            // Sin contentRating explícito la app trata el ítem como "Unknown" y
            // difumina la portada con una "U"; se declara siempre.
            contentRating: this.postIsAdult(post) ? ContentRating.ADULT : ContentRating.MATURE,
        };
    }

    // ---- manga details ----

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const data = await this.getSeriesHTML(mangaId);
        const $ = cheerio.load(data);
        const { block } = this.findSeriesPost(data, mangaId);

        const title =
            this.strField(block, "postTitle")?.trim() ||
            $('meta[property="og:title"]').attr("content")?.trim() ||
            mangaId;

        const secondaryTitles = (this.strField(block, "alternativeTitles") || "")
            .split(/[,|;]/)
            .map((t) => t.trim())
            .filter((t) => t && t !== title);

        let synopsis = this.htmlToText(this.strField(block, "postContent") || "");
        if (!synopsis) synopsis = this.htmlToText(this.decodeEntities($('meta[property="og:description"]').attr("content") || ""));
        if (!synopsis) synopsis = "No description available.";

        const image = this.httpsOr(
            this.strField(block, "featuredImage"),
            this.httpsOr($('meta[property="og:image"]').attr("content"), FALLBACK_COVER),
        );

        const status = this.mapStatus(this.strField(block, "seriesStatus") || "");
        const author = this.strField(block, "author")?.trim() || undefined;
        const artist = this.strField(block, "artist")?.trim() || undefined;

        const avg = this.numField(block, "averageRating");
        const rating = avg !== undefined ? avg / 2 : undefined;

        const tags: Tag[] = this.genreNames(block).map((label) => ({
            id: label.toLowerCase().replace(/\s+/g, "-"),
            title: label,
        }));
        const seriesType = this.strField(block, "seriesType");
        if (seriesType) tags.push({ id: seriesType.toLowerCase(), title: seriesType });

        const tagGroups: TagSection[] = [];
        if (tags.length > 0) tagGroups.push({ id: "genres", title: "Genres", tags });

        const isAdult = tags.some((t) => ADULT_GENRE_RE.test(t.title));

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles,
                thumbnailUrl: image,
                synopsis,
                contentRating: isAdult ? ContentRating.ADULT : ContentRating.MATURE,
                status,
                author,
                artist,
                rating,
                tagGroups,
                shareUrl: `${WEB_URL}/series/${this.pathSegment(mangaId)}`,
            },
        };
    }

    // ---- chapters ----

    // Lista completa vía /api/chapters?postId=N. Por defecto devuelve todos los
    // capítulos; si alguna vez viniera recortada se sigue paginando con `skip`.
    private async fetchApiChapters(postId: number): Promise<ApiChapter[]> {
        const all: ApiChapter[] = [];
        for (let i = 0; i < 20; i++) {
            const skip = all.length > 0 ? `&skip=${all.length}` : "";
            const json = await this.fetchJson<{ post?: { chapters?: ApiChapter[] }; totalChapterCount?: number }>(
                `${API_URL}/api/chapters?postId=${postId}${skip}`,
            );
            const batch = json?.post?.chapters ?? [];
            if (batch.length === 0) break;
            all.push(...batch);
            const total = json?.totalChapterCount ?? 0;
            if (!total || all.length >= total) break;
        }
        return all;
    }

    // Capítulos embebidos en la página (sin fechas): {number:N,slug:"chapter-..."}
    // y los objetos completos de initialChapters ({id:N,slug:"chapter-...",number:N}).
    private parsePageChapters(data: string): { slug: string; number: number }[] {
        const out: { slug: string; number: number }[] = [];
        const re = /\{(?:number:([\d.]+),slug:"(chapter-[A-Za-z0-9_.-]+)"|id:\d+,slug:"(chapter-[A-Za-z0-9_.-]+)",number:([\d.]+))/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(data)) !== null) {
            const slug = m[2] ?? m[3] ?? "";
            const number = parseFloat(m[1] ?? m[4] ?? "");
            if (slug) out.push({ slug, number: Number.isFinite(number) ? number : 0 });
        }
        return out;
    }

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const data = await this.getSeriesHTML(sourceManga.mangaId);
        const { id: postId } = this.findSeriesPost(data, sourceManga.mangaId);

        const chapters: Chapter[] = [];
        const seen = new Set<string>();

        let apiChapters: ApiChapter[] = [];
        if (postId) {
            try {
                apiChapters = await this.fetchApiChapters(postId);
            } catch {
                apiChapters = [];
            }
        }

        for (const ch of apiChapters) {
            const slug = ch.slug;
            if (typeof slug !== "string" || !slug || seen.has(slug)) continue;
            // Capítulos de pago/bloqueados: el lector solo muestra la pantalla de compra.
            if (ch.isAccessible === false || ch.isLocked === true) continue;
            seen.add(slug);
            chapters.push({
                chapterId: this.toSafeId(slug),
                sourceManga,
                title: (ch.title || "").trim() || undefined,
                chapNum: parseFloat(String(ch.number ?? "")) || 0,
                publishDate: ch.createdAt ? new Date(ch.createdAt) : undefined,
                langCode: "en",
            });
        }

        // Sin API (o sin id de post) se cae a lo que haya embebido en la página.
        if (chapters.length === 0) {
            for (const ch of this.parsePageChapters(data)) {
                if (seen.has(ch.slug)) continue;
                seen.add(ch.slug);
                chapters.push({
                    chapterId: ch.slug,
                    sourceManga,
                    chapNum: ch.number,
                    langCode: "en",
                });
            }
        }

        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const url = `${WEB_URL}/series/${this.pathSegment(chapter.sourceManga.mangaId)}/${this.pathSegment(chapter.chapterId)}`;
        const $ = cheerio.load(await this.fetchText(url));

        const pages: string[] = [];
        $("img[data-reader-page-image]").each((_i, el) => {
            const src = ($(el).attr("src") || $(el).attr("data-src") || "").trim();
            if (src.startsWith("https://")) pages.push(src);
        });

        return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
    }

    // ---- search ----

    async getSearchResults(
        query: SearchQuery<Metadata>,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const term = encodeURIComponent(query.title ?? "");
        const json = await this.fetchJson<{ posts?: any[] }>(`${API_URL}/api/query?searchTerm=${term}&perPage=30`);

        const showNsfw = getShowNsfw();
        const items: SearchResultItem[] = [];
        for (const post of json?.posts ?? []) {
            if (!showNsfw && this.postIsAdult(post)) continue;
            const item = this.searchItemFromPost(post);
            if (item) items.push(item);
        }
        return { items, metadata: undefined };
    }

    // ---- discover ----

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return HOME_SECTIONS.map((s) => ({ id: s.key, title: s.title, type: s.type }));
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const data = await this.getPageState("/");
        const showNsfw = getShowNsfw();
        const tiles = this.parseHomeSection(data, section.id).filter((t) => showNsfw || !t.isAdult);

        const items: DiscoverSectionItem[] = tiles.map((t) => {
            const base = {
                mangaId: t.mangaId,
                imageUrl: t.imageUrl,
                title: t.title,
                contentRating: t.isAdult ? ContentRating.ADULT : ContentRating.MATURE,
            };
            if (section.type === DiscoverSectionType.featured)
                return { type: "featuredCarouselItem", ...base };
            if (section.type === DiscoverSectionType.prominentCarousel)
                return { type: "prominentCarouselItem", ...base };
            return { type: "simpleCarouselItem", ...base };
        });

        return { items, metadata: undefined };
    }

    // Posts de una sección del home. Cada uno empieza por
    // {id:N,slug:"...",postTitle:"...",featuredImage:"...",...,genres:[...]}.
    private parseHomeSection(data: string, key: string): HomeTile[] {
        const startMatch = new RegExp(`[{,]${key}:`).exec(data);
        if (!startMatch) return [];
        const start = startMatch.index;

        let end = data.length;
        for (const other of [...HOME_SECTIONS.map((s) => s.key), ...HOME_OTHER_KEYS]) {
            if (other === key) continue;
            const om = new RegExp(`[{,]${other}:`).exec(data.slice(start + 1));
            if (om && start + 1 + om.index < end) end = start + 1 + om.index;
        }

        const seg = data.slice(start, end);
        const postRe = /\{id:(\d+),slug:"((?:\\.|[^"\\])*)",postTitle:"((?:\\.|[^"\\])*)"/g;
        const matches: { m: RegExpExecArray; index: number }[] = [];
        let m: RegExpExecArray | null;
        while ((m = postRe.exec(seg)) !== null) matches.push({ m, index: m.index });

        const out: HomeTile[] = [];
        const seen = new Set<string>();
        for (const [i, entry] of matches.entries()) {
            const cur = entry.m;
            const slug = this.toSafeId(this.decodeString(cur[2] ?? ""));
            const title = this.decodeString(cur[3] ?? "").trim();
            if (!slug || !title || seen.has(slug)) continue;

            // Bloque del post: hasta el siguiente post (los géneros van dentro).
            const block = seg.slice(entry.index, matches[i + 1]?.index ?? seg.length);
            // Las novelas no se pueden leer con este lector de imágenes.
            if (this.isNovel(this.strField(block, "seriesType"), /[{,]isNovel:!0/.test(block))) continue;
            seen.add(slug);

            const isAdult = this.genreNames(block).some((g) => ADULT_GENRE_RE.test(g));
            out.push({
                mangaId: slug,
                title,
                imageUrl: this.httpsOr(this.strField(block, "featuredImage"), FALLBACK_COVER),
                isAdult,
            });
        }
        return out;
    }
}

export const NyxScans = new NyxScansExtension();
