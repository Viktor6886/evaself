/**
 * Разбор документа базы знаний: проверки, антивирус, текст со структурой,
 * фрагменты и прежний вектор pgvector.
 *
 * Разбор файла общий с Telegram-вложениями (`document-text.ts`): второго
 * парсера, а с ним и второго набора проверок на подделку типа и
 * zip-бомбу, быть не должно.
 *
 * Текст документа — данные, а не инструкции. Здесь он обезвреживается без
 * потери структуры (`neutralizeUntrusted`: невидимые знаки и типовые
 * формулировки атак), а конверт «данные, а не инструкции» надевает тот,
 * кто отдаёт фрагменты модели (`knowledge_search`). Прежде конверт
 * вшивался в каждую страницу и склеивал её в одну строку — заголовков,
 * а с ними и разделов, после этого не оставалось.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { neutralizeUntrusted } from "../tools/untrusted.js";
import { neutralizeInstructions } from "./security.js";
import { chunkDocument, type ChunkingOptions } from "./chunking.js";
import { SUPPORTED_DOCUMENT_MIME, extractDocumentOutline } from "./document-text.js";

export interface IngestRequest {
  documentId?: string;
  userId: number | null;
  name: string;
  mime: string;
  bytes: Buffer;
  verifiedProduct?: boolean;
}

export interface KnowledgeChunk {
  documentId?: string;
  userId: number | null;
  productVerified: boolean;
  ordinal: number;
  content: string;
  /** Вектор pgvector (1536): прежний поиск и откат, пока поиск не переключён. */
  embedding: number[] | null;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  subsection: string | null;
  heading: string | null;
  contentHash: string;
  tokenCount: number;
}

export type AntivirusResult = "clean" | "infected" | "unavailable";

export interface IngestDependencies {
  tempRoot: string;
  maxBytes?: number;
  maxPages?: number;
  maxDocxEntries?: number;
  maxDocxParagraphs?: number;
  maxDocxSections?: number;
  /** Нарезка; без неё — прежние 1200/120. */
  chunking?: ChunkingOptions;
  scan(path: string, signal?: AbortSignal): Promise<AntivirusResult>;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  /** Пачка векторов одним запросом; без неё — по одному. */
  embedBatch?(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Текстов в пачке прежних векторов (не больше 64 — предел Router). */
  embedBatchSize?: number;
  /** Qdrant не зависит от старой модели pgvector; её колонка допускает NULL. */
  legacyEmbeddings?: boolean;
  persist(chunks: KnowledgeChunk[], signal?: AbortSignal): Promise<void>;
}

/** Прежняя размерность вектора pgvector — колонка `vector(1536)`. */
const LEGACY_DIMENSION = 1536;
const LEGACY_BATCH = 32;
const ROUTER_BATCH_LIMIT = 64;

export class DocumentIngestor {
  constructor(private readonly dependencies: IngestDependencies) {}

  async ingest(request: IngestRequest, signal?: AbortSignal): Promise<{ chunks: number }> {
    if (!SUPPORTED_DOCUMENT_MIME.has(request.mime)) throw new Error("document_type_unsupported");
    if (!request.bytes.length || request.bytes.byteLength > (this.dependencies.maxBytes ?? 10 * 1024 * 1024)) {
      throw new Error("document_too_large");
    }
    if (!request.verifiedProduct && request.userId === null) throw new Error("document_owner_required");

    const directory = await mkdtemp(join(this.dependencies.tempRoot, "eva-knowledge-"));
    try {
      signal?.throwIfAborted();
      const path = join(directory, "input");
      await writeFile(path, request.bytes, { mode: 0o600 });
      const av = await this.dependencies.scan(path, signal);
      if (av !== "clean") throw new Error(av === "infected" ? "document_antivirus_infected" : "document_antivirus_unavailable");

      const outline = await extractDocumentOutline(request.bytes, request.mime, {
        pages: this.dependencies.maxPages ?? 200,
        entries: this.dependencies.maxDocxEntries ?? 2000,
        paragraphs: this.dependencies.maxDocxParagraphs ?? 20_000,
        sections: this.dependencies.maxDocxSections ?? 500,
      });
      const pieces = chunkDocument(
        // Оба набора формулировок: русские и общие для инструментов
        // (`neutralizeUntrusted`) и прежние для документов, включая
        // «run shell…» и «enable tools…» (`neutralizeInstructions`).
        outline.pages.map((page) => neutralizeInstructions(neutralizeUntrusted(page))),
        outline.paged,
        this.dependencies.chunking ?? { size: 1200, overlap: 120 },
      );

      const vectors = this.dependencies.legacyEmbeddings === false ? null
        : await this.legacyVectors(pieces.map((piece) => piece.content), signal);
      const chunks: KnowledgeChunk[] = pieces.map((piece, index) => ({
        documentId: request.documentId,
        userId: request.userId,
        productVerified: request.verifiedProduct === true,
        ordinal: piece.ordinal,
        content: piece.content,
        embedding: vectors ? vectors[index]! : null,
        pageStart: piece.pageStart,
        pageEnd: piece.pageEnd,
        section: piece.section,
        subsection: piece.subsection,
        heading: piece.heading,
        contentHash: piece.contentHash,
        tokenCount: piece.tokenCount,
      }));
      await this.dependencies.persist(chunks, signal);
      return { chunks: chunks.length };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async legacyVectors(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = [];
    const requested = this.dependencies.embedBatchSize;
    const size = requested !== undefined && Number.isFinite(requested)
      ? Math.min(Math.max(Math.floor(requested), 1), ROUTER_BATCH_LIMIT)
      : LEGACY_BATCH;
    for (let start = 0; start < texts.length; start += size) {
      signal?.throwIfAborted();
      const batch = texts.slice(start, start + size);
      let result: number[][];
      if (this.dependencies.embedBatch) {
        result = await this.dependencies.embedBatch(batch, signal);
      } else {
        result = [];
        for (const text of batch) result.push(await this.dependencies.embed(text, signal));
      }
      if (result.length !== batch.length) throw new Error("embedding_incomplete");
      for (const vector of result) {
        if (vector.length !== LEGACY_DIMENSION) throw new Error("embedding_dimension_invalid");
        vectors.push(vector);
      }
    }
    return vectors;
  }
}
