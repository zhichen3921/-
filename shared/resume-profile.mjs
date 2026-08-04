const skill = (label, terms) => Object.freeze({ label, terms: Object.freeze(terms) });

/**
 * Only facts already approved in the existing application desk are represented
 * here. An empty credentials list is intentional: absence of evidence must not
 * be turned into a claimed qualification.
 */
const publicResumeProfile = Object.freeze({
  name: 'Your Name',
  school: 'Your school',
  degree: 'Your degree / current status',
  graduationYear: '2028',
  credentials: Object.freeze([]),
  skills: Object.freeze([
    skill('Python', ['python']),
    skill('机器学习', ['机器学习', 'machine learning', '算法建模']),
    skill('XGBoost', ['xgboost', 'xgb']),
    skill('LightGBM', ['lightgbm', 'lgbm']),
    skill('SHAP', ['shap', '可解释']),
    skill('数据处理', ['数据清洗', '特征工程', '数据分析', '数据处理']),
    skill('大模型 API', ['大模型', 'llm', 'openai', 'api', 'prompt']),
    skill('MATLAB', ['matlab']),
    skill('电子信息', ['电子信息', '传感器', '半导体', 'stm32', '硬件'])
  ]),
  evidence: Object.freeze(['Add your project evidence here'])
});

const localProfileUrl = new URL('./resume-profile.local.mjs', import.meta.url);
const profileModule = await import(localProfileUrl.href).catch((error) => {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
export const resumeProfile = Object.freeze(
  profileModule?.resumeProfile || profileModule?.default || publicResumeProfile
);

export default resumeProfile;
