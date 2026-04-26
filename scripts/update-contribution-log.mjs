import { readFile, readdir, writeFile } from "node:fs/promises";

const username =
  process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || "rdnsa";
const token =
  process.env.CONTRIBUTION_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const readmePath = process.env.README_PATH || "README.md";
const snakeOutputDir = process.env.SNAKE_OUTPUT_DIR || "dist";
const timeZone = process.env.CONTRIBUTION_TIME_ZONE || "Asia/Jakarta";

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

const gridDays = calendar.weeks.flatMap((week) => week.contributionDays);
const allDays = [...gridDays].sort((a, b) => a.date.localeCompare(b.date));

const activeDays = allDays.filter((day) => day.contributionCount > 0);
const periodStart = allDays[0]?.date ?? "-";
const periodEnd = allDays.at(-1)?.date ?? "-";

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone,
});

const monthFormatter = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  year: "numeric",
  timeZone,
});

const dateTimeFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone,
});

const numberFormatter = new Intl.NumberFormat("id-ID");

function toDate(value) {
  return new Date(`${value}T00:00:00Z`);
}

function formatDate(value) {
  return dateFormatter.format(toDate(value));
}

function formatMonth(value) {
  return monthFormatter.format(toDate(`${value}-01`));
}

function formatDateTime(value) {
  return dateTimeFormatter.format(value);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function formatStreak(streak) {
  if (!streak.length) return "`0 hari`";

  return `\`${numberFormatter.format(streak.length)} hari\` (${formatDate(
    streak.start
  )} sampai ${formatDate(streak.end)})`;
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
    const date = node.occurredAt.slice(0, 10);
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
      )} private/restricted contribution`
    : "0 private/restricted contribution terdeteksi";

const detailNote = truncatedRepositoryDetails
  ? "Sebagian detail repository dipotong oleh batas GraphQL; total contribution tetap memakai angka resmi calendar."
  : hasCommitDetails
    ? "Detail commit repository diambil dari contribution graph GitHub; nama repo private disembunyikan."
    : "Detail commit per repository belum tersedia dari token saat ini.";

const generated = [
  startMarker,
  `Data otomatis dari GitHub contribution calendar untuk akun \`${username}\`.`,
  "",
  `- **Update terakhir:** \`${formatDateTime(new Date())} ${timeZone}\``,
  `- **Periode:** \`${periodStart}\` sampai \`${periodEnd}\``,
  `- **Total contribution:** \`${numberFormatter.format(
    calendar.totalContributions
  )}\``,
  `- **Commit contribution:** \`${numberFormatter.format(
    collection.totalCommitContributions
  )}\` dari \`${numberFormatter.format(
    collection.totalRepositoriesWithContributedCommits
  )}\` repository`,
  `- **Hari aktif:** \`${numberFormatter.format(activeDays.length)}\``,
  `- **Streak aktif terakhir:** ${formatStreak(latestActiveStreak)}`,
  `- **Streak terpanjang:** ${formatStreak(longestStreak)}`,
  `- **Private/restricted:** \`${restrictedSummary}\``,
  "",
  "> Snake mengikuti contribution graph resmi GitHub. Jika commit harian masih terlihat kosong, cek email author commit, branch default/gh-pages, fork, pengaturan private contribution, dan token `CONTRIBUTION_TOKEN` dengan scope `read:user`.",
  "",
  "### Rekap 30 hari terakhir",
  "",
  "| Metrik | Nilai |",
  "| --- | ---: |",
  `| Hari aktif | ${numberFormatter.format(recentActiveDays)} |`,
  `| Hari kosong | ${numberFormatter.format(recentEmptyDays)} |`,
  `| Contribution | ${numberFormatter.format(recentContributionTotal)} |`,
  `| Commit | ${numberFormatter.format(recentCommitTotal)} |`,
  "",
  "### Breakdown resmi",
  "",
  "| Tipe | Total |",
  "| --- | ---: |",
  `| Commit | ${numberFormatter.format(
    collection.totalCommitContributions
  )} |`,
  `| Pull request | ${numberFormatter.format(
    collection.totalPullRequestContributions
  )} |`,
  `| Pull request review | ${numberFormatter.format(
    collection.totalPullRequestReviewContributions
  )} |`,
  `| Issue | ${numberFormatter.format(collection.totalIssueContributions)} |`,
  `| Repository baru | ${numberFormatter.format(
    collection.totalRepositoryContributions
  )} |`,
  "",
  "### Rekap bulanan",
  "",
  "| Bulan | Hari aktif | Contribution | Commit |",
  "| --- | ---: | ---: | ---: |",
  ...(monthlyRows.length ? monthlyRows : ["| - | 0 | 0 | 0 |"]),
  "",
  "### Sumber commit",
  "",
  detailNote,
  "",
  "| Repository | Visibility | Hari commit | Commit |",
  "| --- | --- | ---: | ---: |",
  ...(repositoryRows.length ? repositoryRows : ["| - | - | 0 | 0 |"]),
  "",
  "<details>",
  "<summary>Contribution per hari</summary>",
  "",
  "| Tanggal | Bulan | Contribution | Commit |",
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
  nextReadme = readme.replace("</picture>", `</picture>\n\n${generated}`);
}

if (nextReadme !== readme) {
  await writeFile(readmePath, nextReadme, "utf8");
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
    )} contribution`;
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
    files = await readdir(snakeOutputDir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const svgFiles = files.filter((file) => file.endsWith(".svg"));

  for (const file of svgFiles) {
    const path = `${snakeOutputDir}/${file}`;
    const svg = await readFile(path, "utf8");
    const nextSvg = addSnakeTooltips(svg, gridDays);

    if (nextSvg !== svg) {
      await writeFile(path, nextSvg, "utf8");
    }
  }
}

await updateSnakeTooltips();
