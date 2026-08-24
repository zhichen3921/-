(function installBossPageJobExtractor(globalScope) {
  'use strict';

  const MAX_ITEMS = 20;
  const CARD_ROOT_SELECTORS = Object.freeze([
    '.job-card-wrapper',
    '.job-card',
    'li.job-item',
    '.job-list li',
    '[data-job-id]',
    '.job-list > *'
  ]);
  const FIELD_SELECTORS = Object.freeze({
    title: [
      '.job-name',
      '.job-title',
      '.job-card-left .name',
      '.job-card-body .name',
      '[class*="job-name"]',
      'h3',
      'h2'
    ],
    company: [
      '.company-name',
      '.company-text',
      '.company',
      '[class*="company"]'
    ],
    location: [
      '.job-area',
      '.job-location',
      '.location',
      '[class*="job-area"]',
      '[class*="location"]'
    ],
    salary: [
      '.job-limit',
      '.job-salary',
      '.salary',
      '[class*="salary"]'
    ],
    description: [
      '.job-card-desc',
      '.job-description',
      '.job-card-body .info',
      '.job-info',
      '[class*="job-description"]'
    ]
  });

  class BossCollectorError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'BossCollectorError';
      this.code = code;
    }
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r\n ]+/g, ' ')
      .trim();
  }

  function textFromElement(element) {
    if (!element) return '';
    return cleanText(element.innerText || element.textContent || '');
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    if (element.closest('[hidden], [aria-hidden="true"], [data-active="false"], .inactive, .is-inactive, .hidden, .is-hidden')) {
      return false;
    }
    const view = element.ownerDocument?.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return false;
    let cursor = element;
    while (cursor && cursor.nodeType === 1) {
      const style = view.getComputedStyle(cursor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return false;
      }
      if (Number(style.opacity) === 0) return false;
      cursor = cursor.parentElement;
    }
    return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
  }

  function isZhipinHostname(hostname) {
    const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return normalized === 'zhipin.com' || normalized.endsWith('.zhipin.com');
  }

  function normalizeDetailUrl(candidate, baseHref) {
    if (typeof candidate !== 'string' || !candidate.trim()) return '';
    try {
      const parsed = new URL(candidate.trim(), baseHref);
      if (!isZhipinHostname(parsed.hostname)) return '';
      if (!/^\/(?:job_detail|job-detail)\/[^/?#]+\/?$/i.test(parsed.pathname)) return '';
      parsed.hash = '';
      parsed.search = '';
      return parsed.href;
    } catch {
      return '';
    }
  }

  function detailLinks(root, baseHref) {
    const candidates = [];
    if (root.matches?.('a[href]')) candidates.push(root.getAttribute('href') || root.href);
    for (const anchor of root.querySelectorAll?.('a[href]') || []) {
      if (isVisible(anchor)) candidates.push(anchor.getAttribute('href') || anchor.href);
    }
    return [...new Set(candidates.map((value) => normalizeDetailUrl(value, baseHref)).filter(Boolean))];
  }

  function firstVisibleText(root, selectors) {
    for (const selector of selectors) {
      let elements = [];
      try {
        elements = root.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const element of elements) {
        if (!isVisible(element)) continue;
        const value = textFromElement(element);
        if (value) return value;
      }
    }
    return '';
  }

  function candidateRoots(documentRef, baseHref) {
    const roots = [];
    const seen = new Set();
    for (const selector of CARD_ROOT_SELECTORS) {
      for (const root of documentRef.querySelectorAll(selector)) {
        if (seen.has(root) || !isVisible(root)) continue;
        seen.add(root);
        if (root.closest('.job-detail-page, .job-detail-container, .job-detail-box, .job-detail-content')) continue;
        if (detailLinks(root, baseHref).length) roots.push(root);
      }
    }
    return roots.filter((root) => !roots.some((other) => other !== root && other.contains(root)));
  }

  function extractCard(root, baseHref) {
    const url = detailLinks(root, baseHref)[0] || '';
    const title = firstVisibleText(root, FIELD_SELECTORS.title)
      || textFromElement(root.matches?.('a[href]') ? root : root.querySelector('a[href*="/job_detail/"]'));
    const result = {
      title,
      company: firstVisibleText(root, FIELD_SELECTORS.company),
      location: firstVisibleText(root, FIELD_SELECTORS.location),
      salary: firstVisibleText(root, FIELD_SELECTORS.salary),
      description: firstVisibleText(root, FIELD_SELECTORS.description),
      url
    };
    result.missingFields = Object.entries(result)
      .filter(([field, value]) => field !== 'missingFields' && !value)
      .map(([field]) => field);
    return result;
  }

  function extractCurrentPageJobs(documentRef, locationRef) {
    if (!documentRef || typeof documentRef.querySelectorAll !== 'function') {
      throw new BossCollectorError('INVALID_DOCUMENT', '无法读取当前页面。');
    }
    if (!isZhipinHostname(locationRef?.hostname)) {
      throw new BossCollectorError('NOT_BOSS_PAGE', '请在 BOSS 直聘岗位列表页点击批量采集。');
    }
    if (/^\/(?:job_detail|job-detail)\//i.test(locationRef?.pathname || '')) {
      throw new BossCollectorError('DETAIL_PAGE_NOT_BATCH', '当前是岗位详情页，请切换到岗位列表页后批量采集。');
    }

    const roots = candidateRoots(documentRef, locationRef.href);
    const jobs = [];
    const seenUrls = new Set();
    for (const root of roots) {
      const job = extractCard(root, locationRef.href);
      if (!job.url || seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      jobs.push(job);
    }
    if (jobs.length === 0) {
      throw new BossCollectorError(
        'NO_VISIBLE_JOB_CARDS',
        '当前页面没有可见的岗位卡片，请先打开 BOSS 岗位搜索结果页。'
      );
    }
    return {
      jobs: jobs.slice(0, MAX_ITEMS),
      totalVisible: jobs.length,
      truncated: jobs.length > MAX_ITEMS
    };
  }

  globalScope.BossJobCollectorExtractPage = extractCurrentPageJobs;
  globalScope.BossPageCollectorError = BossCollectorError;
})(globalThis);
