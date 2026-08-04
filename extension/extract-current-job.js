(function installBossCurrentJobExtractor(globalScope) {
  'use strict';

  const DETAIL_CONTAINER_SELECTORS = Object.freeze([
    '.job-detail-page',
    '.job-detail-container',
    '.job-detail-box',
    '.job-detail-content',
    '.job-card-detail',
    '[data-job-detail]'
  ]);

  const FIELD_SELECTORS = Object.freeze({
    title: [
      '.job-title',
      '.job-primary .name h1',
      '.job-primary h1',
      '[class*="job-title"]',
      'h1'
    ],
    company: [
      '.sider-company .company-info a',
      '.company-info .name',
      '.company-name',
      '[class*="company"] h2',
      '[class*="company"] a[title]'
    ],
    location: [
      '.job-primary .location-address',
      '.job-location',
      '.location-address',
      '[class*="job-address"]',
      '[class*="location"]'
    ],
    salary: [
      '.job-primary .salary',
      '.job-salary',
      '[class*="salary"]'
    ],
    description: [
      '.job-detail-section .job-sec-text',
      '.job-sec-text',
      '.job-detail-section .text',
      '[class*="job-description"]',
      '[class*="job-detail"] [class*="text"]'
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

  function hasInactiveMarker(element) {
    return Boolean(element.closest([
      '[hidden]',
      '[aria-hidden="true"]',
      '[data-active="false"]',
      '.inactive',
      '.is-inactive',
      '.hidden',
      '.is-hidden'
    ].join(',')));
  }

  function isVisible(element) {
    if (!element || !element.isConnected || hasInactiveMarker(element)) return false;
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

  function isJobPostingType(type) {
    const values = Array.isArray(type) ? type : [type];
    return values.some((value) => String(value || '').toLowerCase() === 'jobposting');
  }

  function flattenJsonLd(value, output = []) {
    if (!value || typeof value !== 'object') return output;
    if (Array.isArray(value)) {
      for (const item of value) flattenJsonLd(item, output);
      return output;
    }
    if (isJobPostingType(value['@type'])) output.push(value);
    if (value['@graph']) flattenJsonLd(value['@graph'], output);
    return output;
  }

  function readJobPostings(documentRef) {
    const candidates = [];
    const scripts = documentRef.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        flattenJsonLd(JSON.parse(script.textContent || ''), candidates);
      } catch {
        // Invalid third-party metadata is ignored; it never establishes a job page.
      }
    }
    return candidates.filter((candidate) => {
      const organization = candidate?.hiringOrganization;
      const hasCompany = typeof organization === 'string'
        ? Boolean(cleanText(organization))
        : typeof organization?.name === 'string' && Boolean(cleanText(organization.name));
      return typeof candidate?.title === 'string'
        && Boolean(cleanText(candidate.title))
        && ((typeof candidate.description === 'string' && Boolean(cleanText(candidate.description))) || hasCompany);
    });
  }

  function addressText(jobPosting) {
    const locations = Array.isArray(jobPosting.jobLocation)
      ? jobPosting.jobLocation
      : [jobPosting.jobLocation];
    for (const location of locations) {
      const address = location?.address || location;
      if (typeof address === 'string') return cleanText(address);
      if (!address || typeof address !== 'object') continue;
      const parts = [
        address.addressRegion,
        address.addressLocality,
        address.streetAddress
      ].map(cleanText).filter(Boolean);
      if (parts.length) return [...new Set(parts)].join(' · ');
    }
    return '';
  }

  function salaryText(jobPosting) {
    const salary = jobPosting.baseSalary;
    if (salary === null || salary === undefined) return '';
    if (typeof salary === 'string' || typeof salary === 'number') return cleanText(salary);
    const value = salary.value;
    const currency = cleanText(salary.currency);
    if (typeof value === 'string' || typeof value === 'number') {
      return cleanText(`${value}${currency ? ` ${currency}` : ''}`);
    }
    if (!value || typeof value !== 'object') return '';
    const minimum = value.minValue ?? '';
    const maximum = value.maxValue ?? '';
    const unit = cleanText(value.unitText);
    const range = minimum !== '' && maximum !== ''
      ? `${minimum}-${maximum}`
      : String(minimum || maximum || '');
    return cleanText(`${range}${currency ? ` ${currency}` : ''}${unit ? ` / ${unit}` : ''}`);
  }

  function stripHtml(documentRef, html) {
    if (!html) return '';
    const holder = documentRef.createElement('div');
    holder.innerHTML = String(html);
    return textFromElement(holder);
  }

  function companyText(jobPosting) {
    const organization = jobPosting?.hiringOrganization;
    if (typeof organization === 'string') return cleanText(organization);
    return cleanText(organization?.name);
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

  function activeMarker(element) {
    return element.matches([
      '.active',
      '.selected',
      '.is-active',
      '[data-active="true"]',
      '[aria-selected="true"]'
    ].join(','));
  }

  function findActiveDetailContainer(documentRef) {
    const seen = new Set();
    const visible = [];
    for (const selector of DETAIL_CONTAINER_SELECTORS) {
      for (const element of documentRef.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        if (isVisible(element)) visible.push(element);
      }
    }
    if (visible.length === 1) return visible[0];
    const explicitlyActive = visible.filter(activeMarker);
    if (explicitlyActive.length === 1) return explicitlyActive[0];
    if (visible.length > 1 || explicitlyActive.length > 1) {
      throw new BossCollectorError(
        'AMBIGUOUS_ACTIVE_JOB_DETAIL',
        '页面中存在多个可见岗位详情，请只保留一个当前岗位后重试。'
      );
    }
    return null;
  }

  function detailUrlsInside(container, baseHref) {
    if (!container) return [];
    const preferredCandidates = [];
    for (const attribute of ['data-url', 'data-href', 'data-job-url', 'href']) {
      const value = container.getAttribute?.(attribute);
      if (value) preferredCandidates.push(value);
    }
    const preferredSelectors = [
      'a.job-detail-link[href]',
      'a[data-job-url][href]',
      'a[aria-current="page"][href*="/job_detail/"]',
      'a.active[href*="/job_detail/"]',
      '.job-title a[href]',
      'h1 a[href]'
    ];
    for (const selector of preferredSelectors) {
      for (const anchor of container.querySelectorAll(selector)) {
        if (isVisible(anchor)) preferredCandidates.push(anchor.getAttribute('href') || anchor.href);
      }
    }
    for (const anchor of container.querySelectorAll('a[href]')) {
      if (isVisible(anchor) && anchor.querySelector('.job-title, h1')) {
        preferredCandidates.push(anchor.getAttribute('href') || anchor.href);
      }
    }
    const preferredUrls = [...new Set(preferredCandidates
      .map((value) => normalizeDetailUrl(value, baseHref))
      .filter(Boolean))];
    if (preferredUrls.length) return preferredUrls;

    const fallbackCandidates = [];
    for (const anchor of container.querySelectorAll('a[href]')) {
      if (isVisible(anchor)) fallbackCandidates.push(anchor.getAttribute('href') || anchor.href);
    }
    return [...new Set(fallbackCandidates
      .map((value) => normalizeDetailUrl(value, baseHref))
      .filter(Boolean))];
  }

  function resolveUniqueJobUrl({ documentRef, locationRef, container, jobPosting }) {
    const baseHref = locationRef?.href || 'https://www.zhipin.com/';
    const directPageCandidates = [
      documentRef.querySelector('link[rel="canonical"]')?.href,
      locationRef?.href
    ];
    for (const candidate of directPageCandidates) {
      const directPageUrl = normalizeDetailUrl(candidate, baseHref);
      if (directPageUrl) return directPageUrl;
    }

    const insideUrls = detailUrlsInside(container, baseHref);
    if (insideUrls.length === 1) return insideUrls[0];
    if (insideUrls.length > 1) {
      throw new BossCollectorError('AMBIGUOUS_JOB_URL', '当前详情包含多个岗位链接，无法确定要采集哪一个。');
    }

    const authoritativeCandidates = [
      jobPosting?.url,
      documentRef.querySelector('link[rel="canonical"]')?.href,
      locationRef?.href
    ];
    for (const candidate of authoritativeCandidates) {
      const detailUrl = normalizeDetailUrl(candidate, baseHref);
      if (detailUrl) return detailUrl;
    }
    throw new BossCollectorError('NO_UNIQUE_JOB_URL', '没有找到当前岗位唯一的详情链接，请打开岗位详情后重试。');
  }

  function extractCurrentJob(documentRef, locationRef) {
    if (!documentRef || typeof documentRef.querySelector !== 'function') {
      throw new BossCollectorError('INVALID_DOCUMENT', '无法读取当前页面。');
    }
    if (!isZhipinHostname(locationRef?.hostname)) {
      throw new BossCollectorError('NOT_BOSS_PAGE', '请在 BOSS 直聘岗位页面点击采集。');
    }

    let container = findActiveDetailContainer(documentRef);
    const jobPostings = readJobPostings(documentRef);
    const directPageUrl = normalizeDetailUrl(locationRef?.href, locationRef?.href);
    if (!container && directPageUrl && documentRef.body && isVisible(documentRef.body)) {
      container = documentRef.body;
    }
    if (!container && jobPostings.length !== 1) {
      throw new BossCollectorError(
        'NO_ACTIVE_JOB_DETAIL',
        '当前页面不是可采集的岗位详情，请打开一个岗位详情或展开唯一的当前岗位。'
      );
    }

    const jobPosting = jobPostings.length === 1 ? jobPostings[0] : {};
    const url = resolveUniqueJobUrl({ documentRef, locationRef, container, jobPosting });
    const result = container ? {
      title: firstVisibleText(container, FIELD_SELECTORS.title) || cleanText(jobPosting.title),
      company: firstVisibleText(container, FIELD_SELECTORS.company) || companyText(jobPosting),
      location: firstVisibleText(container, FIELD_SELECTORS.location) || addressText(jobPosting),
      salary: firstVisibleText(container, FIELD_SELECTORS.salary) || salaryText(jobPosting),
      description: firstVisibleText(container, FIELD_SELECTORS.description) || stripHtml(documentRef, jobPosting.description),
      url
    } : {
      title: cleanText(jobPosting.title),
      company: companyText(jobPosting),
      location: addressText(jobPosting),
      salary: salaryText(jobPosting),
      description: stripHtml(documentRef, jobPosting.description),
      url
    };
    result.missingFields = Object.entries(result)
      .filter(([field, value]) => field !== 'missingFields' && !value)
      .map(([field]) => field);
    return result;
  }

  globalScope.BossJobCollectorExtract = extractCurrentJob;
  globalScope.BossCollectorError = BossCollectorError;
})(globalThis);
