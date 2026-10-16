/**
 * 答题卡半模态弹窗组件（exam-card.ts）
 * 支持考试模式、普通练习、章节练习与错题练习通用
 */
import "./exam-card.css";
import { esc } from "../../utils";

export interface ExamCardOptions {
  total: number;
  currentIndex: number;
  isAnswered: (index: number) => boolean;
  onSelect: (index: number) => void;
  onSubmit?: () => void;
  submitButtonText?: string;
  title?: string;
}

export class ExamCardSheet {
  private static activeRoot: HTMLElement | null = null;

  static open(options: ExamCardOptions): void {
    this.close();

    const {
      total,
      currentIndex,
      isAnswered,
      onSelect,
      onSubmit,
      submitButtonText = "立即交卷并查看成绩",
      title = "答题卡",
    } = options;

    let answeredCount = 0;
    for (let i = 0; i < total; i++) {
      if (isAnswered(i)) answeredCount++;
    }
    const unAnsweredCount = total - answeredCount;

    const overlay = document.createElement("div");
    overlay.className = "exam-card-overlay";
    overlay.id = "examCardOverlay";

    const sheet = document.createElement("div");
    sheet.className = "exam-card-sheet";

    // 题目列表
    let itemsHtml = "";
    for (let i = 0; i < total; i++) {
      const isCur = i === currentIndex;
      const isAns = isAnswered(i);
      const stateCls = isCur ? "is-current" : isAns ? "is-answered" : "is-unanswered";
      itemsHtml += `<button type="button" class="exam-card-cell ${stateCls}" data-idx="${i}">${i + 1}</button>`;
    }

    sheet.innerHTML = `
      <div class="exam-card-sheet__head">
        <div class="exam-card-sheet__title-row">
          <span class="exam-card-sheet__title">${esc(title)}</span>
          <button type="button" class="exam-card-sheet__close" id="examCardClose" aria-label="关闭">
            <i class="van-icon van-icon-cross"></i>
          </button>
        </div>
        <div class="exam-card-sheet__sub">
          已答 ${answeredCount} / ${total} · 剩余 ${unAnsweredCount} 题未作答
        </div>
      </div>
      <div class="exam-card-sheet__body">
        <div class="exam-card-grid">
          ${itemsHtml}
        </div>
        <div class="exam-card-legend">
          <span class="exam-card-legend__item is-current"><i class="exam-card-legend__dot"></i> 当前题</span>
          <span class="exam-card-legend__item is-answered"><i class="exam-card-legend__dot"></i> 已作答</span>
          <span class="exam-card-legend__item is-unanswered"><i class="exam-card-legend__dot"></i> 未作答</span>
        </div>
      </div>
      ${onSubmit ? `
        <div class="exam-card-sheet__foot">
          <button type="button" class="btn btn--block exam-card-sheet__submit" id="examCardSubmit">
            ${esc(submitButtonText)}
          </button>
        </div>
      ` : ""}
    `;

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    this.activeRoot = overlay;

    // 进场动画
    requestAnimationFrame(() => {
      overlay.classList.add("is-visible");
      sheet.classList.add("is-visible");
    });

    const doClose = (): void => {
      this.close();
    };

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) doClose();
    });
    sheet.querySelector("#examCardClose")?.addEventListener("click", doClose);

    // 绑定题号跳转
    sheet.querySelectorAll<HTMLButtonElement>(".exam-card-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        const idx = Number(cell.dataset.idx);
        doClose();
        onSelect(idx);
      });
    });

    // 绑定交卷
    if (onSubmit) {
      sheet.querySelector("#examCardSubmit")?.addEventListener("click", () => {
        doClose();
        onSubmit();
      });
    }
  }

  static close(): void {
    if (!this.activeRoot) return;
    const el = this.activeRoot;
    this.activeRoot = null;
    el.classList.remove("is-visible");
    const sheet = el.querySelector(".exam-card-sheet");
    if (sheet) sheet.classList.remove("is-visible");
    setTimeout(() => {
      el.remove();
    }, 200);
  }
}
