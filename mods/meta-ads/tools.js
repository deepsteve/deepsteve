const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');

const CONFIG_FILE = path.join(os.homedir(), '.deepsteve', 'meta-ads.json');
const DATA_DIR = path.join(os.homedir(), '.deepsteve', 'meta-ads');
const KB_PATH = path.join(DATA_DIR, 'knowledge-base.md');

// ── Config ──────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return { accessToken: '', adAccountId: '' };
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function maskToken(token) {
  if (!token || token.length <= 8) return '';
  return '***' + token.slice(-8);
}

// ── SDK helpers ─────────────────────────────────────────────

function initSdk() {
  const config = loadConfig();
  if (!config.accessToken || !config.adAccountId) {
    return null;
  }
  const bizSdk = require('facebook-nodejs-business-sdk');
  bizSdk.FacebookAdsApi.init(config.accessToken);
  return {
    account: new bizSdk.AdAccount(config.adAccountId),
    Campaign: bizSdk.Campaign,
    AdSet: bizSdk.AdSet,
    Ad: bizSdk.Ad,
  };
}

const CREDENTIAL_ERROR = {
  content: [{ type: 'text', text: 'Error: Meta Ads credentials not configured. Open the Meta Ads panel in the sidebar and enter your access token and ad account ID.' }],
  isError: true,
};

const INSIGHT_FIELDS = [
  'impressions', 'clicks', 'spend', 'cpc', 'cpm', 'ctr',
  'reach', 'frequency', 'actions', 'cost_per_action_type', 'action_values',
];

function errorResult(e) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text', text: `Error: ${msg}` }] };
}

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// ── Experiment helpers ──────────────────────────────────────

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveExperiment(experiment) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, `experiment-${slugify(experiment.name)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(experiment, null, 2));
}

function loadExperiment(name) {
  const filePath = path.join(DATA_DIR, `experiment-${slugify(name)}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function listAllExperiments() {
  ensureDataDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('experiment-') && f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8')));
}

function updateVariantMetrics(experimentName, variantKey, metrics) {
  const experiment = loadExperiment(experimentName);
  if (!experiment || !experiment.variants[variantKey]) return null;
  Object.assign(experiment.variants[variantKey], metrics);
  saveExperiment(experiment);
  return experiment;
}

function concludeExp(name, winner, learnings) {
  const experiment = loadExperiment(name);
  if (!experiment) return null;
  experiment.status = 'concluded';
  experiment.winner = winner;
  experiment.learnings = learnings;
  experiment.endDate = new Date().toISOString().split('T')[0];
  saveExperiment(experiment);
  return experiment;
}

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function calculateSignificance(a, b, metric) {
  const nA = a.sampleSize ?? a.impressions;
  const nB = b.sampleSize ?? b.impressions;
  const xA = a[metric];
  const xB = b[metric];
  if (nA === 0 || nB === 0) {
    return { zScore: 0, pValue: 1, significant: false, conversionRateA: 0, conversionRateB: 0 };
  }
  const pA = xA / nA, pB = xB / nB;
  const pPooled = (xA + xB) / (nA + nB);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / nA + 1 / nB));
  if (se === 0) {
    return { zScore: 0, pValue: 1, significant: false, conversionRateA: pA, conversionRateB: pB };
  }
  const zScore = (pA - pB) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));
  return { zScore, pValue, significant: pValue < 0.05, conversionRateA: pA, conversionRateB: pB };
}

// ── Knowledge base helpers ──────────────────────────────────

const SECTION_HEADERS = {
  works: '## What Works',
  doesnt_work: "## What Doesn't Work",
  open_question: '## Open Questions',
};

function getKnowledgeBase() {
  if (!fs.existsSync(KB_PATH)) return '';
  return fs.readFileSync(KB_PATH, 'utf-8');
}

function addLearning(category, entry) {
  ensureDataDir();
  let content = getKnowledgeBase();
  const header = SECTION_HEADERS[category];
  const idx = content.indexOf(header);
  if (idx === -1) {
    content += `\n${header}\n- ${entry}\n`;
  } else {
    const insertPos = idx + header.length;
    const nextLine = content.indexOf('\n', insertPos);
    content = content.slice(0, nextLine + 1) + `- ${entry}\n` + content.slice(nextLine + 1);
  }
  fs.writeFileSync(KB_PATH, content);
}

// ── Routes ──────────────────────────────────────────────────

function registerRoutes(app) {
  app.get('/api/meta-ads/config', (req, res) => {
    const config = loadConfig();
    res.json({
      accessTokenMasked: maskToken(config.accessToken),
      adAccountId: config.adAccountId || '',
    });
  });

  app.post('/api/meta-ads/config', (req, res) => {
    const config = loadConfig();
    if (req.body.accessToken !== undefined) config.accessToken = req.body.accessToken;
    if (req.body.adAccountId !== undefined) config.adAccountId = req.body.adAccountId;
    saveConfig(config);
    res.json({
      accessTokenMasked: maskToken(config.accessToken),
      adAccountId: config.adAccountId,
    });
  });
}

// ── Tool definitions ────────────────────────────────────────

function init(context) {
  return {
    // ── Read tools ────────────────────────────────────────
    get_campaigns: {
      description: 'List all campaigns in the ad account',
      schema: {
        status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
      },
      handler: async ({ status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const fields = ['name', 'status', 'objective', 'daily_budget', 'lifetime_budget', 'start_time', 'stop_time'];
          const params = {};
          if (status) params.effective_status = [status];
          const campaigns = await sdk.account.getCampaigns(fields, params);
          return jsonResult(campaigns);
        } catch (e) { return errorResult(e); }
      },
    },

    get_campaign_insights: {
      description: 'Get performance metrics for a campaign over a date range',
      schema: {
        campaign_id: z.string(),
        date_from: z.string().describe('YYYY-MM-DD'),
        date_to: z.string().describe('YYYY-MM-DD'),
      },
      handler: async ({ campaign_id, date_from, date_to }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const campaign = new sdk.Campaign(campaign_id);
          const insights = await campaign.getInsights(INSIGHT_FIELDS, {
            time_range: { since: date_from, until: date_to },
          });
          return jsonResult(insights);
        } catch (e) { return errorResult(e); }
      },
    },

    get_ad_insights: {
      description: 'Get performance metrics for a specific ad',
      schema: {
        ad_id: z.string(),
        date_from: z.string().describe('YYYY-MM-DD'),
        date_to: z.string().describe('YYYY-MM-DD'),
      },
      handler: async ({ ad_id, date_from, date_to }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const ad = new sdk.Ad(ad_id);
          const insights = await ad.getInsights(INSIGHT_FIELDS, {
            time_range: { since: date_from, until: date_to },
          });
          return jsonResult(insights);
        } catch (e) { return errorResult(e); }
      },
    },

    get_account_summary: {
      description: 'Get a summary of the entire ad account performance',
      schema: {
        date_from: z.string().describe('YYYY-MM-DD'),
        date_to: z.string().describe('YYYY-MM-DD'),
      },
      handler: async ({ date_from, date_to }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const insights = await sdk.account.getInsights(INSIGHT_FIELDS, {
            time_range: { since: date_from, until: date_to },
          });
          return jsonResult(insights);
        } catch (e) { return errorResult(e); }
      },
    },

    get_ad_sets: {
      description: 'List ad sets in a campaign',
      schema: {
        campaign_id: z.string(),
        status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
      },
      handler: async ({ campaign_id, status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const campaign = new sdk.Campaign(campaign_id);
          const fields = ['name', 'status', 'daily_budget', 'lifetime_budget', 'daily_min_spend_target', 'daily_spend_cap', 'budget_remaining', 'optimization_goal', 'targeting', 'billing_event', 'start_time', 'end_time', 'effective_status', 'learning_stage_info'];
          const params = {};
          if (status) params.effective_status = [status];
          const adSets = await campaign.getAdSets(fields, params);
          return jsonResult(adSets);
        } catch (e) { return errorResult(e); }
      },
    },

    get_ads: {
      description: 'List ads in an ad set',
      schema: {
        ad_set_id: z.string(),
        status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
      },
      handler: async ({ ad_set_id, status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const adSet = new sdk.AdSet(ad_set_id);
          const fields = ['name', 'status', 'creative', 'adset_id'];
          const params = {};
          if (status) params.effective_status = [status];
          const ads = await adSet.getAds(fields, params);
          return jsonResult(ads);
        } catch (e) { return errorResult(e); }
      },
    },

    get_ad_set_insights: {
      description: 'Get performance metrics for an ad set over a date range',
      schema: {
        ad_set_id: z.string(),
        date_from: z.string().describe('YYYY-MM-DD'),
        date_to: z.string().describe('YYYY-MM-DD'),
      },
      handler: async ({ ad_set_id, date_from, date_to }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const adSet = new sdk.AdSet(ad_set_id);
          const insights = await adSet.getInsights(INSIGHT_FIELDS, {
            time_range: { since: date_from, until: date_to },
          });
          return jsonResult(insights);
        } catch (e) { return errorResult(e); }
      },
    },

    // ── Write tools ───────────────────────────────────────
    create_campaign: {
      description: 'Create a new campaign (defaults to PAUSED)',
      schema: {
        name: z.string(),
        objective: z.enum([
          'OUTCOME_APP_PROMOTION', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT',
          'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_TRAFFIC',
        ]),
        status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'),
        daily_budget: z.string().optional().describe('Daily budget in cents (e.g. "1000" = $10.00)'),
        special_ad_categories: z.array(z.string()).default([]),
      },
      handler: async ({ name, objective, status, daily_budget, special_ad_categories }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const params = { name, objective, status, special_ad_categories };
          if (daily_budget) params.daily_budget = daily_budget;
          const result = await sdk.account.createCampaign([], params);
          return jsonResult(result);
        } catch (e) { return errorResult(e); }
      },
    },

    create_ad_set: {
      description: 'Create a new ad set within a campaign (defaults to PAUSED). Budgets are in cents as strings.',
      schema: {
        campaign_id: z.string(),
        name: z.string(),
        daily_budget: z.string().describe('Daily budget in cents (e.g. "1000" = $10.00)'),
        optimization_goal: z.string().describe('e.g. APP_INSTALLS, LINK_CLICKS, REACH'),
        targeting: z.object({
          geo_locations: z.object({
            countries: z.array(z.string()).optional(),
          }).optional(),
          age_min: z.number().optional(),
          age_max: z.number().optional(),
        }).passthrough(),
        billing_event: z.string().default('IMPRESSIONS'),
        status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'),
      },
      handler: async ({ campaign_id, name, daily_budget, optimization_goal, targeting, billing_event, status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const params = { campaign_id, name, daily_budget, optimization_goal, targeting, billing_event, status };
          const result = await sdk.account.createAdSet([], params);
          return jsonResult(result);
        } catch (e) { return errorResult(e); }
      },
    },

    create_ad: {
      description: 'Create a new ad in an ad set (defaults to PAUSED)',
      schema: {
        adset_id: z.string(),
        name: z.string(),
        creative_id: z.string().describe('ID of an existing ad creative'),
        status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'),
      },
      handler: async ({ adset_id, name, creative_id, status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const params = { adset_id, name, creative: { creative_id }, status };
          const result = await sdk.account.createAd([], params);
          return jsonResult(result);
        } catch (e) { return errorResult(e); }
      },
    },

    pause_resume_campaign: {
      description: 'Pause or resume a campaign',
      schema: {
        campaign_id: z.string(),
        action: z.enum(['pause', 'resume']),
      },
      handler: async ({ campaign_id, action }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const campaign = new sdk.Campaign(campaign_id);
          const newStatus = action === 'pause' ? 'PAUSED' : 'ACTIVE';
          const result = await campaign.update([], { status: newStatus });
          return jsonResult({ id: campaign_id, status: newStatus, result });
        } catch (e) { return errorResult(e); }
      },
    },

    pause_resume_ad_set: {
      description: 'Pause or resume an ad set',
      schema: {
        ad_set_id: z.string(),
        action: z.enum(['pause', 'resume']),
      },
      handler: async ({ ad_set_id, action }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const adSet = new sdk.AdSet(ad_set_id);
          const newStatus = action === 'pause' ? 'PAUSED' : 'ACTIVE';
          const result = await adSet.update([], { status: newStatus });
          return jsonResult({ id: ad_set_id, status: newStatus, result });
        } catch (e) { return errorResult(e); }
      },
    },

    create_ad_creative: {
      description: 'Create an ad creative for use with create_ad',
      schema: {
        name: z.string(),
        page_id: z.string().describe('Facebook Page ID'),
        image_hash: z.string().optional().describe('Image hash from uploaded image'),
        image_url: z.string().optional().describe('URL of the image'),
        video_id: z.string().optional().describe('ID of uploaded video'),
        title: z.string().optional().describe('Ad headline'),
        body: z.string().optional().describe('Ad body text'),
        link_url: z.string().optional().describe('Destination URL'),
        call_to_action_type: z.string().optional().describe('e.g. INSTALL_MOBILE_APP, LEARN_MORE, SHOP_NOW'),
      },
      handler: async ({ name, page_id, image_hash, image_url, video_id, title, body, link_url, call_to_action_type }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const object_story_spec = { page_id };
          const link_data = {};
          if (image_hash) link_data.image_hash = image_hash;
          if (image_url) link_data.picture = image_url;
          if (title) link_data.name = title;
          if (body) link_data.message = body;
          if (link_url) link_data.link = link_url;
          if (call_to_action_type) link_data.call_to_action = { type: call_to_action_type };

          if (video_id) {
            const video_data = { video_id };
            if (title) video_data.title = title;
            if (body) video_data.message = body;
            if (link_url) video_data.link_url = link_url;
            if (call_to_action_type) video_data.call_to_action = { type: call_to_action_type, value: { link: link_url } };
            object_story_spec.video_data = video_data;
          } else {
            object_story_spec.link_data = link_data;
          }

          const result = await sdk.account.createAdCreative([], { name, object_story_spec });
          return jsonResult(result);
        } catch (e) { return errorResult(e); }
      },
    },

    update_budget: {
      description: 'Update daily or lifetime budget for a campaign or ad set. Budget in cents as string.',
      schema: {
        level: z.enum(['campaign', 'ad_set']),
        id: z.string(),
        daily_budget: z.string().optional().describe('Daily budget in cents'),
        lifetime_budget: z.string().optional().describe('Lifetime budget in cents'),
      },
      handler: async ({ level, id, daily_budget, lifetime_budget }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const params = {};
          if (daily_budget) params.daily_budget = daily_budget;
          if (lifetime_budget) params.lifetime_budget = lifetime_budget;
          const entity = level === 'campaign' ? new sdk.Campaign(id) : new sdk.AdSet(id);
          const result = await entity.update([], params);
          return jsonResult({ id, level, ...params, result });
        } catch (e) { return errorResult(e); }
      },
    },

    update_targeting: {
      description: 'Update targeting for an ad set',
      schema: {
        ad_set_id: z.string(),
        targeting: z.object({
          geo_locations: z.object({
            countries: z.array(z.string()).optional(),
          }).optional(),
          age_min: z.number().optional(),
          age_max: z.number().optional(),
        }).passthrough(),
      },
      handler: async ({ ad_set_id, targeting }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const adSet = new sdk.AdSet(ad_set_id);
          const result = await adSet.update([], { targeting });
          return jsonResult({ id: ad_set_id, targeting, result });
        } catch (e) { return errorResult(e); }
      },
    },

    // ── Experiment tools ──────────────────────────────────
    create_experiment: {
      description: 'Create a new A/B test experiment with hypothesis and variants',
      schema: {
        name: z.string(),
        hypothesis: z.string(),
        variants: z.record(z.object({
          adId: z.string().default(''),
          description: z.string(),
          spend: z.number().default(0),
          impressions: z.number().default(0),
          clicks: z.number().default(0),
          conversions: z.number().default(0),
          cpa: z.number().default(0),
          roas: z.number().default(0),
        })),
        checkInDate: z.string().optional(),
        tags: z.array(z.string()).optional(),
        metrics: z.string().optional(),
        notes: z.string().optional(),
      },
      handler: async ({ name, hypothesis, variants, checkInDate, tags, metrics, notes }) => {
        const experiment = {
          name,
          hypothesis,
          variants,
          startDate: new Date().toISOString().split('T')[0],
          status: 'running',
          checkInDate: checkInDate ?? null,
          tags: tags ?? [],
          metrics,
          notes: notes ?? null,
          snapshots: [],
        };
        saveExperiment(experiment);
        return { content: [{ type: 'text', text: `Experiment "${name}" created.` }] };
      },
    },

    update_experiment_metrics: {
      description: 'Update performance metrics for a variant in an experiment',
      schema: {
        experiment_name: z.string(),
        variant_key: z.string(),
        metrics: z.object({
          spend: z.number().optional(),
          impressions: z.number().optional(),
          clicks: z.number().optional(),
          conversions: z.number().optional(),
          cpa: z.number().optional(),
          roas: z.number().optional(),
          ctr: z.number().optional(),
          costPerClick: z.number().optional(),
          sampleSize: z.number().optional(),
        }),
      },
      handler: async ({ experiment_name, variant_key, metrics }) => {
        const result = updateVariantMetrics(experiment_name, variant_key, metrics);
        if (!result) return { content: [{ type: 'text', text: 'Experiment or variant not found.' }] };
        return jsonResult(result.variants[variant_key]);
      },
    },

    conclude_experiment: {
      description: 'Mark an experiment as concluded with a winner and learnings',
      schema: {
        name: z.string(),
        winner: z.string(),
        learnings: z.string(),
      },
      handler: async ({ name, winner, learnings }) => {
        const result = concludeExp(name, winner, learnings);
        if (!result) return { content: [{ type: 'text', text: 'Experiment not found.' }] };
        return { content: [{ type: 'text', text: `Experiment "${name}" concluded. Winner: ${winner}` }] };
      },
    },

    get_experiment: {
      description: 'Read a single experiment by name',
      schema: { name: z.string() },
      handler: async ({ name }) => {
        const experiment = loadExperiment(name);
        if (!experiment) return { content: [{ type: 'text', text: 'Experiment not found.' }] };
        return jsonResult(experiment);
      },
    },

    list_experiments: {
      description: 'List all experiments with their status',
      schema: {},
      handler: async () => {
        const experiments = listAllExperiments();
        const summary = experiments.map(e => ({
          name: e.name,
          status: e.status,
          startDate: e.startDate,
          winner: e.winner ?? null,
        }));
        return jsonResult(summary);
      },
    },

    check_significance: {
      description: 'Run A/B significance test between two variants of an experiment',
      schema: {
        experiment_name: z.string(),
        variant_a: z.string(),
        variant_b: z.string(),
        metric: z.enum(['conversions', 'clicks']).default('conversions'),
      },
      handler: async ({ experiment_name, variant_a, variant_b, metric }) => {
        const experiment = loadExperiment(experiment_name);
        if (!experiment) return { content: [{ type: 'text', text: 'Experiment not found.' }] };
        const a = experiment.variants[variant_a];
        const b = experiment.variants[variant_b];
        if (!a || !b) return { content: [{ type: 'text', text: 'Variant not found.' }] };
        return jsonResult(calculateSignificance(a, b, metric));
      },
    },

    // ── Knowledge base tools ──────────────────────────────
    add_learning: {
      description: 'Add an entry to the marketing knowledge base',
      schema: {
        category: z.enum(['works', 'doesnt_work', 'open_question']),
        entry: z.string(),
      },
      handler: async ({ category, entry }) => {
        addLearning(category, entry);
        return { content: [{ type: 'text', text: `Added to "${category}": ${entry}` }] };
      },
    },

    get_knowledge_base: {
      description: 'Read the full marketing knowledge base',
      schema: {},
      handler: async () => {
        const kb = getKnowledgeBase();
        return { content: [{ type: 'text', text: kb || 'Knowledge base is empty.' }] };
      },
    },
  };
}

module.exports = { init, registerRoutes };
