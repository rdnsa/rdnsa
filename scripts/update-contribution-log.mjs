import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const username =
  process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || "rdnsa";
const token =
  process.env.CONTRIBUTION_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const readmePath = process.env.README_PATH || "README.md";
const outputDir = process.env.SNAKE_OUTPUT_DIR || "dist";
const timeZone = process.env.CONTRIBUTION_TIME_ZONE || "Asia/Jakarta";
const locale = process.env.CONTRIBUTION_LOCALE || "en-US";

const startMarker = "<!-- CONTRIBUTION-STATS:START -->";
const endMarker = "<!-- CONTRIBUTION-STATS:END -->";

if (!token) {
  throw new Error(
    "Set GITHUB_TOKEN or CONTRIBUTION_TOKEN to update the contribution log."
  );
}

const query = `
  query ContributionCalendar($login: String!) {
    user(login: $login) {
      contributionsCollection {
        startedAt
        endedAt
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalRepositoryContributions
        totalRepositoriesWithContributedCommits
        restrictedContributionsCount
        hasAnyRestrictedContributions
        earliestRestrictedContributionDate
        latestRestrictedContributionDate
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              weekday
              contributionCount
              contributionLevel
            }
          }
        }
        commitContributionsByRepository(maxRepositories: 25) {
          repository {
            nameWithOwner
            url
            isPrivate
          }
          contributions(first: 100) {
            totalCount
            nodes {
              occurredAt
              commitCount
            }
          }
        }
      }
    }
  }
`;

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "rdnsa-profile-readme",
  },
  body: JSON.stringify({ query, variables: { login: username } }),
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`GitHub GraphQL request failed: ${response.status} ${body}`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(payload.errors.map((error) => error.message).join("; "));
}

const collection = payload.data?.user?.contributionsCollection;
const calendar = collection?.contributionCalendar;

if (!calendar) {
  throw new Error(`No GitHub contribution calendar found for ${username}.`);
}

const weeks = calendar.weeks;
const gridDays = weeks.flatMap((week) => week.contributionDays);
const allDays = [...gridDays].sort((a, b) => a.date.localeCompare(b.date));

const activeDays = allDays.filter((day) => day.contributionCount > 0);
const periodStart = allDays[0]?.date ?? "-";
const periodEnd = allDays.at(-1)?.date ?? "-";

const dateFormatter = new Intl.DateTimeFormat(locale, {
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone,
});

const monthFormatter = new Intl.DateTimeFormat(locale, {
  month: "long",
  year: "numeric",
  timeZone,
});

const shortMonthFormatter = new Intl.DateTimeFormat(locale, {
  month: "short",
  timeZone,
});

const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
  day: "2-digit",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone,
});

const isoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone,
});

const numberFormatter = new Intl.NumberFormat(locale);

function toDate(value) {
  return new Date(`${value}T00:00:00Z`);
}

function formatDate(value) {
  return dateFormatter.format(toDate(value));
}

function formatMonth(value) {
  return monthFormatter.format(toDate(`${value}-01`));
}

function formatShortMonth(value) {
  return shortMonthFormatter.format(toDate(`${value}-01`));
}

function formatDateTime(value) {
  return dateTimeFormatter.format(value);
}

function toCalendarDate(value) {
  const parts = isoDateFormatter.formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatStreak(streak) {
  if (!streak.length) return "`0 days`";

  return `\`${numberFormatter.format(streak.length)} ${pluralize(
    streak.length,
    "day"
  )}\` (${formatDate(streak.start)} to ${formatDate(streak.end)})`;
}

function getLongestStreak(days, isActive) {
  let currentStart = null;
  let currentLength = 0;
  let longest = { length: 0, start: null, end: null };

  for (const day of days) {
    if (isActive(day)) {
      currentStart ??= day.date;
      currentLength += 1;

      if (currentLength > longest.length) {
        longest = {
          length: currentLength,
          start: currentStart,
          end: day.date,
        };
      }
    } else {
      currentStart = null;
      currentLength = 0;
    }
  }

  return longest;
}

function getStreakEndingAt(days, endIndex, isActive) {
  if (endIndex < 0) return { length: 0, start: null, end: null };

  let length = 0;
  let start = null;
  const end = days[endIndex].date;

  for (let index = endIndex; index >= 0; index -= 1) {
    const day = days[index];
    if (!isActive(day)) break;

    length += 1;
    start = day.date;
  }

  return { length, start, end };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function contributionLevelIndex(day) {
  const byLevel = {
    NONE: 0,
    FIRST_QUARTILE: 1,
    SECOND_QUARTILE: 2,
    THIRD_QUARTILE: 3,
    FOURTH_QUARTILE: 4,
  };

  if (day.contributionLevel in byLevel) return byLevel[day.contributionLevel];
  if (!day.contributionCount) return 0;
  if (day.contributionCount < 3) return 1;
  if (day.contributionCount < 6) return 2;
  if (day.contributionCount < 10) return 3;
  return 4;
}

const commitCountsByDate = new Map();
const publicRepositoryRows = [];
const privateRepositorySummary = {
  days: new Set(),
  repoCount: 0,
  totalCommits: 0,
};
let truncatedRepositoryDetails = false;

for (const group of collection.commitContributionsByRepository ?? []) {
  const repository = group.repository;
  const nodes = group.contributions?.nodes ?? [];
  const totalContributions = group.contributions?.totalCount ?? nodes.length;
  const days = new Set();
  let totalCommits = 0;

  if (totalContributions > nodes.length) {
    truncatedRepositoryDetails = true;
  }

  for (const node of nodes) {
    const date = toCalendarDate(node.occurredAt);
    days.add(date);
    totalCommits += node.commitCount;
    commitCountsByDate.set(
      date,
      (commitCountsByDate.get(date) ?? 0) + node.commitCount
    );
  }

  if (!totalCommits) continue;

  if (repository?.isPrivate) {
    privateRepositorySummary.repoCount += 1;
    privateRepositorySummary.totalCommits += totalCommits;
    for (const date of days) privateRepositorySummary.days.add(date);
  } else {
    publicRepositoryRows.push({
      name: repository.nameWithOwner,
      url: repository.url,
      days: days.size,
      totalCommits,
    });
  }
}

const hasCommitDetails = commitCountsByDate.size > 0;
const latestActiveDayIndex = allDays.findLastIndex(
  (day) => day.contributionCount > 0
);
const latestActiveStreak = getStreakEndingAt(
  allDays,
  latestActiveDayIndex,
  (day) => day.contributionCount > 0
);
const longestStreak = getLongestStreak(
  allDays,
  (day) => day.contributionCount > 0
);

const monthlyTotals = new Map();

for (const day of allDays) {
  const month = day.date.slice(0, 7);
  const current = monthlyTotals.get(month) ?? {
    activeDays: 0,
    total: 0,
    commits: 0,
  };

  current.total += day.contributionCount;
  current.commits += commitCountsByDate.get(day.date) ?? 0;
  if (day.contributionCount > 0) current.activeDays += 1;
  monthlyTotals.set(month, current);
}

const monthlyRows = [...monthlyTotals.entries()]
  .filter(([, month]) => month.total > 0)
  .sort(([a], [b]) => b.localeCompare(a))
  .map(
    ([month, value]) =>
      `| ${formatMonth(month)} | ${numberFormatter.format(
        value.activeDays
      )} | ${numberFormatter.format(value.total)} | ${numberFormatter.format(
        value.commits
      )} |`
  );

const dailyRows = activeDays
  .slice()
  .reverse()
  .map(
    (day) =>
      `| ${formatDate(day.date)} | ${formatMonth(
        day.date.slice(0, 7)
      )} | ${numberFormatter.format(
        day.contributionCount
      )} | ${numberFormatter.format(commitCountsByDate.get(day.date) ?? 0)} |`
  );

const recentDays = allDays.slice(-30);
const recentContributionTotal = sum(
  recentDays.map((day) => day.contributionCount)
);
const recentCommitTotal = sum(
  recentDays.map((day) => commitCountsByDate.get(day.date) ?? 0)
);
const recentActiveDays = recentDays.filter(
  (day) => day.contributionCount > 0
).length;
const recentEmptyDays = recentDays.length - recentActiveDays;

const repositoryRows = publicRepositoryRows
  .sort((a, b) => b.totalCommits - a.totalCommits)
  .slice(0, 8)
  .map(
    (repository) =>
      `| [${repository.name}](${repository.url}) | Public | ${numberFormatter.format(
        repository.days
      )} | ${numberFormatter.format(repository.totalCommits)} |`
  );

if (privateRepositorySummary.totalCommits > 0) {
  repositoryRows.push(
    `| Private repositories | Private | ${numberFormatter.format(
      privateRepositorySummary.days.size
    )} | ${numberFormatter.format(privateRepositorySummary.totalCommits)} |`
  );
}

const restrictedSummary =
  collection.hasAnyRestrictedContributions ||
  collection.restrictedContributionsCount > 0
    ? `${numberFormatter.format(
        collection.restrictedContributionsCount
      )} private/restricted ${pluralize(
        collection.restrictedContributionsCount,
        "contribution"
      )}`
    : "0 private/restricted contributions detected";

const detailNote = truncatedRepositoryDetails
  ? "Some repository details were truncated by the GraphQL limit; total contributions still use the official GitHub calendar."
  : hasCommitDetails
    ? "Repository commit details come from the GitHub contribution graph; private repository names stay hidden."
    : "Repository commit details are not available with the current token.";

const generated = [
  startMarker,
  `Automatically generated from the GitHub contribution calendar for \`${username}\`.`,
  "",
  `- **Last updated:** \`${formatDateTime(new Date())} ${timeZone}\``,
  `- **Period:** \`${periodStart}\` to \`${periodEnd}\``,
  `- **Total contributions:** \`${numberFormatter.format(
    calendar.totalContributions
  )}\``,
  `- **Commit contributions:** \`${numberFormatter.format(
    collection.totalCommitContributions
  )}\` across \`${numberFormatter.format(
    collection.totalRepositoriesWithContributedCommits
  )}\` repositories`,
  `- **Active days:** \`${numberFormatter.format(activeDays.length)}\``,
  `- **Latest active streak:** ${formatStreak(latestActiveStreak)}`,
  `- **Longest streak:** ${formatStreak(longestStreak)}`,
  `- **Private/restricted:** \`${restrictedSummary}\``,
  "",
  "> The dashboard and snake follow GitHub's official contribution graph. Empty days usually mean GitHub did not count a commit for that date yet, or the commit did not meet GitHub contribution rules such as verified author email, default branch or gh-pages branch, non-fork repository, private contribution settings, and a CONTRIBUTION_TOKEN with read:user scope.",
  "",
  "### Last 30 Days",
  "",
  "| Metric | Value |",
  "| --- | ---: |",
  `| Active days | ${numberFormatter.format(recentActiveDays)} |`,
  `| Empty days | ${numberFormatter.format(recentEmptyDays)} |`,
  `| Contributions | ${numberFormatter.format(recentContributionTotal)} |`,
  `| Commits | ${numberFormatter.format(recentCommitTotal)} |`,
  "",
  "### Official Breakdown",
  "",
  "| Type | Total |",
  "| --- | ---: |",
  `| Commits | ${numberFormatter.format(
    collection.totalCommitContributions
  )} |`,
  `| Pull requests | ${numberFormatter.format(
    collection.totalPullRequestContributions
  )} |`,
  `| Pull request reviews | ${numberFormatter.format(
    collection.totalPullRequestReviewContributions
  )} |`,
  `| Issues | ${numberFormatter.format(collection.totalIssueContributions)} |`,
  `| New repositories | ${numberFormatter.format(
    collection.totalRepositoryContributions
  )} |`,
  "",
  "### Monthly Recap",
  "",
  "| Month | Active days | Contributions | Commits |",
  "| --- | ---: | ---: | ---: |",
  ...(monthlyRows.length ? monthlyRows : ["| - | 0 | 0 | 0 |"]),
  "",
  "### Commit Sources",
  "",
  detailNote,
  "",
  "| Repository | Visibility | Commit days | Commits |",
  "| --- | --- | ---: | ---: |",
  ...(repositoryRows.length ? repositoryRows : ["| - | - | 0 | 0 |"]),
  "",
  "<details>",
  "<summary>Daily contribution log</summary>",
  "",
  "| Date | Month | Contributions | Commits |",
  "| --- | --- | ---: | ---: |",
  ...(dailyRows.length ? dailyRows : ["| - | - | 0 | 0 |"]),
  "",
  "</details>",
  endMarker,
].join("\n");

const readme = await readFile(readmePath, "utf8");
let nextReadme;

if (readme.includes(startMarker) && readme.includes(endMarker)) {
  nextReadme = readme.replace(
    new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`),
    generated
  );
} else {
  nextReadme = `${readme.trimEnd()}\n\n${generated}\n`;
}

if (nextReadme !== readme) {
  await writeFile(readmePath, nextReadme, "utf8");
}

function getMonthLabels() {
  const labels = [];
  let lastMonth = null;

  weeks.forEach((week, weekIndex) => {
    const firstDay = week.contributionDays[0];
    if (!firstDay) return;

    const month = firstDay.date.slice(0, 7);
    if (month === lastMonth) return;

    labels.push({
      label: formatShortMonth(month),
      weekIndex,
    });
    lastMonth = month;
  });

  return labels;
}

function generateContributionDashboardSvg(themeName) {
  const dark = themeName === "dark";
  const theme = dark
    ? {
        background: "#0d1117",
        border: "#30363d",
        cellBorder: "#30363d",
        text: "#e6edf3",
        muted: "#8b949e",
        subtle: "#c9d1d9",
        empty: "#161b22",
        colors: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
        pill: "#1f6feb",
        pillText: "#ffffff",
        line: "#30363d",
      }
    : {
        background: "#ffffff",
        border: "#d0d7de",
        cellBorder: "#d0d7de",
        text: "#24292f",
        muted: "#57606a",
        subtle: "#24292f",
        empty: "#ebedf0",
        colors: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
        pill: "#0969da",
        pillText: "#ffffff",
        line: "#d8dee4",
      };

  const cell = 10;
  const gap = 3;
  const step = cell + gap;
  const height = 420;
  const graphX = 24;
  const graphY = 52;
  const gridX = 68;
  const gridY = 86;
  const gridWidth = weeks.length * step;
  const graphWidth = gridX - graphX + gridWidth + 28;
  const graphHeight = 156;
  const sidebarX = graphX + graphWidth + 30;
  const width = Math.max(920, sidebarX + 112);
  const activityY = graphY + graphHeight + 46;
  const year = periodEnd.slice(0, 4);
  const month = formatMonth(periodEnd.slice(0, 7));
  const commitCount = collection.totalCommitContributions;
  const repoCount = collection.totalRepositoriesWithContributedCommits;
  const createdRepoCount = collection.totalRepositoryContributions;
  const prCount = collection.totalPullRequestContributions;
  const reviewCount = collection.totalPullRequestReviewContributions;
  const issueCount = collection.totalIssueContributions;
  const latestActivityItems = [
    `Created ${numberFormatter.format(commitCount)} ${pluralize(
      commitCount,
      "commit"
    )} in ${numberFormatter.format(repoCount)} ${pluralize(
      repoCount,
      "repository",
      "repositories"
    )}`,
    `Created ${numberFormatter.format(createdRepoCount)} ${pluralize(
      createdRepoCount,
      "repository",
      "repositories"
    )}`,
    `Opened ${numberFormatter.format(prCount)} pull ${pluralize(
      prCount,
      "request"
    )}, reviewed ${numberFormatter.format(reviewCount)}, and opened ${numberFormatter.format(
      issueCount
    )} ${pluralize(issueCount, "issue")}`,
  ];

  const monthLabels = getMonthLabels()
    .map(
      ({ label, weekIndex }) =>
        `<text x="${gridX + weekIndex * step}" y="${
          gridY - 14
        }" fill="${theme.text}" font-size="12">${escapeHtml(label)}</text>`
    )
    .join("");

  const weekdayLabels = [
    { label: "Mon", day: 1 },
    { label: "Wed", day: 3 },
    { label: "Fri", day: 5 },
  ]
    .map(
      ({ label, day }) =>
        `<text x="${graphX + 10}" y="${
          gridY + day * step + cell - 1
        }" fill="${theme.text}" font-size="12">${label}</text>`
    )
    .join("");

  const cells = weeks
    .map((week, weekIndex) =>
      week.contributionDays
        .map((day) => {
          const weekday =
            typeof day.weekday === "number"
              ? day.weekday
              : new Date(`${day.date}T00:00:00Z`).getUTCDay();
          const level = contributionLevelIndex(day);
          const x = gridX + weekIndex * step;
          const y = gridY + weekday * step;
          const label = `${formatDate(day.date)}: ${numberFormatter.format(
            day.contributionCount
          )} ${pluralize(day.contributionCount, "contribution")}`;

          return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${theme.colors[level]}" stroke="${theme.cellBorder}"><title>${escapeHtml(
            label
          )}</title></rect>`;
        })
        .join("")
    )
    .join("");

  const legendX = graphX + graphWidth - 170;
  const legendCells = theme.colors
    .map(
      (color, index) =>
        `<rect x="${legendX + 34 + index * 14}" y="${
          graphY + graphHeight - 28
        }" width="10" height="10" rx="2" fill="${color}" stroke="${
          theme.cellBorder
        }"/>`
    )
    .join("");

  const yearPills = [Number(year), Number(year) - 1, Number(year) - 2]
    .map((item, index) => {
      const y = graphY + index * 48;
      const active = index === 0;
      return active
        ? `<rect x="${sidebarX}" y="${y}" width="96" height="34" rx="6" fill="${theme.pill}"/><text x="${
            sidebarX + 17
          }" y="${y + 22}" fill="${theme.pillText}" font-size="12">${item}</text>`
        : `<text x="${sidebarX + 17}" y="${y + 22}" fill="${
            theme.text
          }" font-size="12">${item}</text>`;
    })
    .join("");

  const activityRows = latestActivityItems
    .map((item, index) => {
      const y = activityY + 48 + index * 44;
      return [
        `<circle cx="${graphX + 17}" cy="${y - 6}" r="14" fill="${
          dark ? "#161b22" : "#f6f8fa"
        }" stroke="${theme.border}"/>`,
        `<path d="M${graphX + 11} ${y - 7}h12M${graphX + 17} ${
          y - 13
        }v12" stroke="${theme.muted}" stroke-width="1.6"/>`,
        `<text x="${graphX + 48}" y="${y}" fill="${
          theme.text
        }" font-size="16">${escapeHtml(item)}</text>`,
      ].join("");
    })
    .join("");

  const description = `${calendar.totalContributions} contributions from ${periodStart} to ${periodEnd}`;

  return [
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escapeHtml(
      `${numberFormatter.format(calendar.totalContributions)} contributions in the last year`
    )}</title>`,
    `<desc id="desc">${escapeHtml(description)}</desc>`,
    `<rect width="${width}" height="${height}" rx="10" fill="${theme.background}"/>`,
    `<text x="${graphX}" y="30" fill="${theme.text}" font-size="16" font-weight="600">${numberFormatter.format(
      calendar.totalContributions
    )} contributions in the last year</text>`,
    `<rect x="${graphX}" y="${graphY}" width="${graphWidth}" height="${graphHeight}" rx="2" fill="${theme.background}" stroke="${theme.border}"/>`,
    monthLabels,
    weekdayLabels,
    cells,
    `<text x="${graphX + 42}" y="${graphY + graphHeight - 18}" fill="${
      theme.muted
    }" font-size="12">Learn how we count contributions</text>`,
    `<text x="${legendX}" y="${graphY + graphHeight - 19}" fill="${
      theme.muted
    }" font-size="12">Less</text>`,
    legendCells,
    `<text x="${legendX + 110}" y="${
      graphY + graphHeight - 19
    }" fill="${theme.muted}" font-size="12">More</text>`,
    yearPills,
    `<text x="${graphX}" y="${activityY}" fill="${theme.text}" font-size="16" font-weight="600">Contribution activity</text>`,
    `<text x="${graphX + 8}" y="${activityY + 39}" fill="${
      theme.text
    }" font-size="13" font-weight="600">${escapeHtml(month)}</text>`,
    `<line x1="${graphX + 96}" y1="${activityY + 34}" x2="${
      graphX + graphWidth
    }" y2="${activityY + 34}" stroke="${theme.line}"/>`,
    `<line x1="${graphX + 17}" y1="${activityY + 50}" x2="${
      graphX + 17
    }" y2="${activityY + 150}" stroke="${theme.border}" stroke-width="2"/>`,
    activityRows,
    `<text x="${graphX}" y="${height - 18}" fill="${theme.muted}" font-size="11">Generated from GitHub GraphQL contribution data. Private counts are included when the token can read them.</text>`,
    "</svg>",
  ].join("");
}

async function writeContributionDashboardSvgs() {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    `${outputDir}/github-contribution-dashboard.svg`,
    generateContributionDashboardSvg("light"),
    "utf8"
  );
  await writeFile(
    `${outputDir}/github-contribution-dashboard-dark.svg`,
    generateContributionDashboardSvg("dark"),
    "utf8"
  );
}

function addSnakeTooltips(svg, days) {
  let index = 0;
  const cellPattern =
    /<rect\b(?=[^>]*\bclass="[^"]*\bc\b[^"]*")[^>]*(?:\/>|>[\s\S]*?<\/rect>)/g;

  const nextSvg = svg.replace(cellPattern, (rect) => {
    const day = days[index];
    index += 1;

    if (!day) return rect;

    const label = `${formatDate(day.date)}: ${numberFormatter.format(
      day.contributionCount
    )} ${pluralize(day.contributionCount, "contribution")}`;
    const openingTag = rect.match(/^<rect\b[^>]*\/?>/)?.[0];

    if (!openingTag) return rect;

    const cleanOpeningTag = openingTag
      .replace(/\sdata-date="[^"]*"/, "")
      .replace(/\sdata-contribution-count="[^"]*"/, "");
    const tagStart = cleanOpeningTag.endsWith("/>")
      ? cleanOpeningTag.slice(0, -2)
      : cleanOpeningTag.slice(0, -1);

    return `${tagStart} data-date="${escapeHtml(
      day.date
    )}" data-contribution-count="${day.contributionCount}"><title>${escapeHtml(
      label
    )}</title></rect>`;
  });

  if (index > 0 && index !== days.length) {
    console.warn(
      `Annotated ${index} snake cells, but GitHub returned ${days.length} contribution days.`
    );
  }

  return nextSvg;
}

async function updateSnakeTooltips() {
  let files;

  try {
    files = await readdir(outputDir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const svgFiles = files.filter(
    (file) => file.endsWith(".svg") && file.includes("snake")
  );

  for (const file of svgFiles) {
    const path = `${outputDir}/${file}`;
    const svg = await readFile(path, "utf8");
    const nextSvg = addSnakeTooltips(svg, gridDays);

    if (nextSvg !== svg) {
      await writeFile(path, nextSvg, "utf8");
    }
  }
}

await writeContributionDashboardSvgs();
await updateSnakeTooltips();
