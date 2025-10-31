import Ajv from "ajv";
import schema from "../schemas/ai_response_schema.json" assert { type: "json" };

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn = ajv.compile(schema);

/**
 * validateAIResponse(obj)
 * - obj: AI からのパース結果（JSオブジェクト）
 * - 戻り: { valid: boolean, errors: null | Array }
 */
export function validateAIResponse(obj) {
  const valid = validateFn(obj);
  return { valid: !!valid, errors: valid ? null : (validateFn.errors || []) };
}

/**
 * formatErrors(errors)
 * - 開発用に読みやすい文字列を返す（必要に応じてフロント表示に利用）
 */
export function formatErrors(errors) {
  if (!errors || errors.length === 0) return null;
  return errors.map(e => `${e.instancePath || '/'} ${e.message || ''}`).join("; ");
}
