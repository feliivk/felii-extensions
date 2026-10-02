import {
    Source,
    Manga,
    Chapter,
    ChapterDetails,
    HomeSection,
    SearchRequest,
    PagedResults,
    SourceInfo,
    ContentRating,
    Request,
    Response,
    SourceIntents,
    HomeSectionType,
    MangaTile,
    Tag
} from '@paperback/types';

import * as cheerio from 'cheerio';

// URLs Base
const WEB_URL = "https://hivetoons.org";
const API_URL = "https://api.hivetoons.org";
const STORAGE_HOST = "storage.hivetoon.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FALLBACK_COVER = "https://placehold.co/400x600?text=No+Cover";

// Caché del HTML de /series/{slug} y del home (getMangaDetails/getChapters y las
// secciones del home reutilizan la misma página)
const PAGE_CACHE_TTL = 60_000;
const PAGE_CACHE_MAX = 30;

// Secciones del home: clave del estado embebido → sección de Paperback.
// `todayPosts` viene envuelto en {data:{posts:[...]}}, el resto son arrays.
const HOME_SECTIONS: { key: string; title: string; large: boolean }[] = [
    { key: "combinedSliderPosts", title: "Featured", large: true },
    { key: "todayPosts", title: "Popular Today", large: false },
    { key: "latestMangaPosts", title: "Latest Releases", large: false },
    { key: "weeklyPosts", title: "Popular This Week", large: false },
    { key: "monthlyPosts", title: "Popular This Month", large: false },
];
// Otras claves del estado que delimitan el final de una sección
// (firstHeroImageSrc va justo después del slider, que es la última).
const HOME_OTHER_KEYS = ["latestNovelPosts", "publishedCollections", "firstHeroImageSrc"];

export const HiveToonsInfo: SourceInfo = {
    version: '1.1.0',
    name: 'HiveToons',
    icon: 'icon.png',
    author: 'Felii',
    authorWebsite: 'https://github.com/feliivk',
    description: 'Lectura desde HiveToons (hivetoons.org)',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: WEB_URL,
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS
};

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

export class HiveToons extends Source {

    requestManager = createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    "Referer": `${WEB_URL}/`,
                    "Origin": WEB_URL,
                    "User-Agent": USER_AGENT,
                    "Accept": "*/*"
                };
                return request;
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response;
            },
        },
    });

    private pageCache = new Map<string, { data: string; expiry: number }>();

    CloudFlareError(status: number) {
        if (status === 503 || status === 403) {
            throw new Error(`CLOUDFLARE BYPASS ERROR: Please go to the homepage of the source and press Cloudflare Bypass. Status code: ${status}`);
        }
    }

    private async fetchText(url: string): Promise<string> {
        const request = createRequestObject({ url, method: "GET" });
        const response = await this.requestManager.schedule(request, 1);
        this.CloudFlareError(response.status);
        return response.data || "";
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
        return this.getPageState(`/series/${mangaId}`);
    }

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

    // Decodifica entidades HTML comunes
    decodeEntities(text: string): string {
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

    // Mapea el estado textual de la web al enum numérico de Paperback
    mapStatus(statusText: string): number {
        const s = (statusText || "").toUpperCase();
        if (s.includes("COMPLETED") || s.includes("ENDED") || s.includes("FINISHED")) return 1; // COMPLETED
        if (s.includes("HIATUS") || s.includes("PAUSED")) return 2; // HIATUS
        if (s.includes("CANCEL") || s.includes("DROPPED")) return 3; // ABANDONED
        return 0; // ONGOING
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

    // Convierte un "post" del API /api/query en un MangaTile
    tileFromPost(post: any): MangaTile | undefined {
        const id = post?.slug;
        const title = post?.postTitle;
        const image = post?.featuredImage || FALLBACK_COVER;
        if (!id || !title) return undefined;
        return createMangaTile({
            id: id,
            title: createIconText({ text: title }),
            image: image
        });
    }

    // 1. Detalles del manga (estado embebido en la página de la serie, con meta OG de respaldo)
    async getMangaDetails(mangaId: string): Promise<Manga> {
        const data = await this.getSeriesHTML(mangaId);
        const $ = cheerio.load(data);
        const { block } = this.findSeriesPost(data, mangaId);

        const title =
            this.strField(block, "postTitle")?.trim() ||
            $('meta[property="og:title"]').attr('content')?.trim() ||
            mangaId;

        const altTitles = (this.strField(block, "alternativeTitles") || "")
            .split(/[,|;]/)
            .map((t) => t.trim())
            .filter((t) => t && t !== title);

        let desc = this.htmlToText(this.strField(block, "postContent") || "");
        if (!desc) desc = this.htmlToText(this.decodeEntities($('meta[property="og:description"]').attr('content') || ""));
        if (!desc) desc = "Sin descripción disponible.";

        // Portada: preferir la del storage propio; si no, cualquier https; si no, og:image.
        let image = this.strField(block, "featuredImage") || "";
        const storageCover = new RegExp(`featuredImage:"(https://${STORAGE_HOST.replace(/\./g, "\\.")}/[^"]+)"`).exec(block);
        if (storageCover?.[1]) image = this.decodeString(storageCover[1]);
        if (!image.startsWith("https://")) image = $('meta[property="og:image"]').attr('content') || FALLBACK_COVER;

        const status = this.mapStatus(this.strField(block, "seriesStatus") || "");
        const author = this.strField(block, "author")?.trim() || "Desconocido";
        const artist = this.strField(block, "artist")?.trim() || "";

        const avg = this.numField(block, "averageRating");
        const rating = avg !== undefined ? avg / 2 : 0;

        const tags: Tag[] = this.genreNames(block).map((label) => createTag({ id: label, label, type: 'blue' }));
        const seriesType = this.strField(block, "seriesType");
        if (seriesType) tags.push(createTag({ id: seriesType, label: seriesType, type: 'green' }));

        return createManga({
            id: mangaId,
            titles: [title, ...altTitles],
            image: image,
            rating: rating,
            status: status,
            author: author,
            artist: artist,
            desc: desc,
            hentai: false,
            tags: [createTagSection({ id: '0', label: 'Géneros', tags })]
        });
    }

    // Lista completa vía /api/chapters?postId=N. Por defecto devuelve todos los
    // capítulos; si alguna vez viniera recortada se sigue paginando con `skip`.
    private async fetchApiChapters(postId: number): Promise<ApiChapter[]> {
        const all: ApiChapter[] = [];
        for (let i = 0; i < 20; i++) {
            const skip = all.length > 0 ? `&skip=${all.length}` : "";
            const raw = await this.fetchText(`${API_URL}/api/chapters?postId=${postId}${skip}`);
            const json = JSON.parse(raw) as { post?: { chapters?: ApiChapter[] }; totalChapterCount?: number };
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

    // 2. Capítulos (API JSON del sitio; la página embebida como respaldo)
    async getChapters(mangaId: string): Promise<Chapter[]> {
        const data = await this.getSeriesHTML(mangaId);
        const { id: postId } = this.findSeriesPost(data, mangaId);

        const chapters: Chapter[] = [];
        const seen = new Set<string>();

        let apiChapters: ApiChapter[] = [];
        if (postId) {
            try {
                apiChapters = await this.fetchApiChapters(postId);
            } catch (e) {
                apiChapters = [];
            }
        }

        for (const ch of apiChapters) {
            const slug = ch.slug;
            if (!slug || seen.has(slug)) continue;
            // Capítulos de pago/bloqueados: el lector solo muestra la pantalla de compra.
            if (ch.isAccessible === false || ch.isLocked === true) continue;
            seen.add(slug);

            const numText = String(ch.number ?? "");
            const chapNum = parseFloat(numText) || 0;
            const rawTitle = (ch.title || "").trim();
            const name = rawTitle ? `Chapter ${numText} - ${rawTitle}` : `Chapter ${numText}`;

            chapters.push(createChapter({
                id: slug,
                mangaId: mangaId,
                name: name,
                chapNum: chapNum,
                time: ch.createdAt ? new Date(ch.createdAt) : new Date(),
                langCode: "en"
            }));
        }

        // Sin API (o sin id de post) se cae a lo que haya embebido en la página.
        if (chapters.length === 0) {
            for (const ch of this.parsePageChapters(data)) {
                if (seen.has(ch.slug)) continue;
                seen.add(ch.slug);
                chapters.push(createChapter({
                    id: ch.slug,
                    mangaId: mangaId,
                    name: `Chapter ${ch.number}`,
                    chapNum: ch.number,
                    time: new Date(),
                    langCode: "en"
                }));
            }
        }

        // Más reciente primero
        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    // 3. Páginas del capítulo (imágenes en el HTML del lector)
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const $ = cheerio.load(await this.fetchText(`${WEB_URL}/series/${mangaId}/${chapterId}`));

        const pages: string[] = [];
        $('img[data-reader-page-image]').each((_i, el) => {
            const src = ($(el).attr('src') || $(el).attr('data-src') || '').trim();
            if (src.startsWith("https://")) pages.push(src);
        });

        return createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        });
    }

    // 4. Búsqueda (API JSON)
    async getSearchResults(query: SearchRequest, _metadata: any): Promise<PagedResults> {
        const term = encodeURIComponent(query.title ?? "");
        const raw = await this.fetchText(`${API_URL}/api/query?searchTerm=${term}&perPage=30`);

        let json: any;
        try {
            json = JSON.parse(raw);
        } catch (e) {
            throw new Error(`Error parsing JSON for search: ${e}`);
        }

        const tiles: MangaTile[] = [];
        for (const post of (json?.posts ?? [])) {
            const tile = this.tileFromPost(post);
            if (tile) tiles.push(tile);
        }

        return createPagedResults({
            results: tiles
        });
    }

    // Posts de una sección del home. Cada uno empieza por
    // {id:N,slug:"...",postTitle:"...",featuredImage:"...",...,genres:[...]}.
    parseHomeSection(data: string, key: string): MangaTile[] {
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

        const tiles: MangaTile[] = [];
        const seen = new Set<string>();
        for (const [i, entry] of matches.entries()) {
            const cur = entry.m;
            const slug = this.decodeString(cur[2] ?? "");
            const title = this.decodeString(cur[3] ?? "").trim();
            if (!slug || !title || seen.has(slug)) continue;

            // Bloque del post: hasta el siguiente post.
            const block = seg.slice(entry.index, matches[i + 1]?.index ?? seg.length);
            // Las novelas no se pueden leer con este lector de imágenes.
            if (/[{,]isNovel:!0/.test(block)) continue;
            seen.add(slug);

            const image = this.strField(block, "featuredImage") || "";
            tiles.push(createMangaTile({
                id: slug,
                title: createIconText({ text: title }),
                image: image.startsWith("https://") ? image : FALLBACK_COVER
            }));
        }
        return tiles;
    }

    // 5. Secciones de la página principal (estado embebido en el HTML del home)
    override async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const data = await this.getPageState("/");

        for (const s of HOME_SECTIONS) {
            const section = createHomeSection({
                id: s.key,
                title: s.title,
                type: s.large ? HomeSectionType.singleRowLarge : HomeSectionType.singleRowNormal,
                view_more: false
            });
            sectionCallback(section);
            section.items = this.parseHomeSection(data, s.key);
            sectionCallback(section);
        }
    }
}
