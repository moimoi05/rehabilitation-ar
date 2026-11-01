"use strict";
(self["webpackChunkbrowser_extension"] = self["webpackChunkbrowser_extension"] || []).push([["471"], {
"./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/modify-header-info.js"(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {
__webpack_require__.d(__webpack_exports__, {
  _: () => (ModifyHeaderInfoValidator)
});
/* import */ var valibot__rspack_import_1 = __webpack_require__("./node_modules/.pnpm/valibot@1.4.2_typescript@5.6.3/node_modules/valibot/dist/index.mjs");
/* import */ var _utils_valibot_js__rspack_import_0 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/utils/valibot.js");



/**
 * Enum that represents the possible operations for a header modification.
 *
 * @see {@link https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#type-HeaderOperation}
 *
 * @since Chrome 86
 */ var HeaderOperation = /*#__PURE__*/ function(HeaderOperation) {
    /**
     * Adds a new entry for the specified header.
     * This operation is not supported for request headers.
     */ HeaderOperation["Append"] = "append";
    /**
     * Sets a new value for the specified header, removing any existing headers with the same name.
     */ HeaderOperation["Set"] = "set";
    /**
     * Removes all entries for the specified header.
     */ HeaderOperation["Remove"] = "remove";
    return HeaderOperation;
}({});
/**
 * Validator for {@link ModifyHeaderInfo}.
 */ const ModifyHeaderInfoValidator = (0,_utils_valibot_js__rspack_import_0/* .strictObjectByType */.A)({
    header: valibot__rspack_import_1/* .string */.YjP(),
    operation: valibot__rspack_import_1/* ["enum"] */.k5n(HeaderOperation),
    value: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP())
});




},
"./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/query-key-value.js"(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {
__webpack_require__.d(__webpack_exports__, {
  V: () => (QueryKeyValueValidator)
});
/* import */ var valibot__rspack_import_1 = __webpack_require__("./node_modules/.pnpm/valibot@1.4.2_typescript@5.6.3/node_modules/valibot/dist/index.mjs");
/* import */ var _utils_valibot_js__rspack_import_0 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/utils/valibot.js");



/**
 * Validator for {@link QueryKeyValue}.
 */ const QueryKeyValueValidator = (0,_utils_valibot_js__rspack_import_0/* .strictObjectByType */.A)({
    key: valibot__rspack_import_1/* .string */.YjP(),
    replaceOnly: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .boolean */.zMY()),
    value: valibot__rspack_import_1/* .string */.YjP()
});




},
"./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/query-transform.js"(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {
__webpack_require__.d(__webpack_exports__, {
  T: () => (QueryTransformValidator)
});
/* import */ var valibot__rspack_import_1 = __webpack_require__("./node_modules/.pnpm/valibot@1.4.2_typescript@5.6.3/node_modules/valibot/dist/index.mjs");
/* import */ var _utils_valibot_js__rspack_import_0 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/utils/valibot.js");
/* import */ var _query_key_value_js__rspack_import_2 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/query-key-value.js");




/**
 * Validator for {@link QueryTransform}.
 */ const QueryTransformValidator = (0,_utils_valibot_js__rspack_import_0/* .strictObjectByType */.A)({
    addOrReplaceParams: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .array */.YOg(_query_key_value_js__rspack_import_2/* .QueryKeyValueValidator */.V)),
    removeParams: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .array */.YOg(valibot__rspack_import_1/* .string */.YjP()))
});




},
"./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/redirect.js"(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {
__webpack_require__.d(__webpack_exports__, {
  T: () => (RedirectValidator)
});
/* import */ var valibot__rspack_import_1 = __webpack_require__("./node_modules/.pnpm/valibot@1.4.2_typescript@5.6.3/node_modules/valibot/dist/index.mjs");
/* import */ var _utils_valibot_js__rspack_import_0 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/utils/valibot.js");
/* import */ var _url_transform_js__rspack_import_2 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/url-transform.js");




/**
 * Validator for {@link Redirect}.
 */ const RedirectValidator = (0,_utils_valibot_js__rspack_import_0/* .strictObjectByType */.A)({
    extensionPath: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP()),
    regexSubstitution: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP()),
    transform: valibot__rspack_import_1/* .optional */.lqM(_url_transform_js__rspack_import_2/* .URLTransformValidator */.W),
    url: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP())
});




},
"./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/rule-action.js"(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {
__webpack_require__.d(__webpack_exports__, {
  J: () => (RuleActionType)
});
/* import */ var valibot__rspack_import_1 = __webpack_require__("./node_modules/.pnpm/valibot@1.4.2_typescript@5.6.3/node_modules/valibot/dist/index.mjs");
/* import */ var _utils_valibot_js__rspack_import_0 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/utils/valibot.js");
/* import */ var _modify_header_info_js__rspack_import_3 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/modify-header-info.js");
/* import */ var _redirect_js__rspack_import_2 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/redirect.js");





/**
 * Enum that represents the kind of action to take if a given condition matches.
 *
 * @see {@link https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#type-RuleActionType}
 */ var RuleActionType = /*#__PURE__*/ function(RuleActionType) {
    /**
     * Block the network request.
     */ RuleActionType["Block"] = "block";
    /**
     * Redirect the network request.
     */ RuleActionType["Redirect"] = "redirect";
    /**
     * Allow the network request.
     *
     * The request won't be intercepted if there is an allow rule which matches it.
     */ RuleActionType["Allow"] = "allow";
    /**
     * Upgrade the network request url's scheme to `https` if the request is `http` or `ftp`.
     */ RuleActionType["UpgradeScheme"] = "upgradeScheme";
    /**
     * Modify request/response headers from the network request.
     *
     * @since Chrome 86
     */ RuleActionType["ModifyHeaders"] = "modifyHeaders";
    /**
     * Allow all requests within a frame hierarchy, including the frame request itself.
     */ RuleActionType["AllowAllRequests"] = "allowAllRequests";
    return RuleActionType;
}({});
/**
 * Validator for {@link RuleAction}.
 */ const RuleActionValidator = (0,_utils_valibot_js__rspack_import_0/* .strictObjectByType */.A)({
    redirect: valibot__rspack_import_1/* .optional */.lqM(_redirect_js__rspack_import_2/* .RedirectValidator */.T),
    requestHeaders: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .array */.YOg(_modify_header_info_js__rspack_import_3/* .ModifyHeaderInfoValidator */._)),
    responseHeaders: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .array */.YOg(_modify_header_info_js__rspack_import_3/* .ModifyHeaderInfoValidator */._)),
    type: valibot__rspack_import_1/* ["enum"] */.k5n(RuleActionType)
});




},
"./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/url-transform.js"(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {
__webpack_require__.d(__webpack_exports__, {
  W: () => (URLTransformValidator)
});
/* import */ var valibot__rspack_import_1 = __webpack_require__("./node_modules/.pnpm/valibot@1.4.2_typescript@5.6.3/node_modules/valibot/dist/index.mjs");
/* import */ var _utils_valibot_js__rspack_import_0 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/utils/valibot.js");
/* import */ var _query_transform_js__rspack_import_2 = __webpack_require__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/declarative-rule/query-transform.js");




/**
 * Enum that represents URL transformation schemes.
 *
 * @see {@link https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#type-URLTransform}
 */ var URLTransformScheme = /*#__PURE__*/ function(URLTransformScheme) {
    URLTransformScheme["Http"] = "http";
    URLTransformScheme["Https"] = "https";
    URLTransformScheme["Ftp"] = "ftp";
    URLTransformScheme["ChromeExtension"] = "chrome-extension";
    return URLTransformScheme;
}({});
/**
 * Validator for {@link URLTransform}.
 */ const URLTransformValidator = (0,_utils_valibot_js__rspack_import_0/* .strictObjectByType */.A)({
    fragment: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP()),
    host: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP()),
    password: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP()),
    path: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP()),
    port: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP()),
    query: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP()),
    queryTransform: valibot__rspack_import_1/* .optional */.lqM(_query_transform_js__rspack_import_2/* .QueryTransformValidator */.T),
    scheme: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* ["enum"] */.k5n(URLTransformScheme)),
    username: valibot__rspack_import_1/* .optional */.lqM(valibot__rspack_import_1/* .string */.YjP())
});




},
"./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/index.js"() {


































},
"./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/utils/valibot.js"(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {
__webpack_require__.d(__webpack_exports__, {
  A: () => (strictObjectByType)
});
/* import */ var valibot__rspack_import_0 = __webpack_require__("./node_modules/.pnpm/valibot@1.4.2_typescript@5.6.3/node_modules/valibot/dist/index.mjs");


/**
 * Creates a strict object schema by validating the entries against the expected type.
 *
 * @template TExpected The expected type for the object schema.
 * @template TEntries The entries of the object schema.
 *
 * @see {@link strictObject}
 *
 * @param entries The entries schema.
 *
 * @returns A strict object schema.
 *
 * @example
 * ```ts
 * // Valid case
 * interface ValidExample {
 *     foo: string;
 * }
 *
 * const ValidExampleValidator = strictObjectByType<ValidExample>({
 *     foo: v.string(),
 * });
 *
 * // Invalid case
 * interface InvalidExample {
 *     foo: string;
 *     bar: number;
 * }
 *
 * const InvalidExampleValidator = strictObjectByType<InvalidExample>({
 *     foo: v.string(),
 *     baz: v.boolean(), // Error: Does not match the expected type
 *     // Error: Property 'bar' is missing
 * });
 * ```
 */ function strictObjectByType(entries) {
    return (0,valibot__rspack_import_0/* .strictObject */.rej)(entries);
}
/**
 * Recursively extracts message from Valibot issue.
 *
 * @param issue Valibot's {@link BaseIssue}.
 * @param nesting Nesting level prefix (e.g. `'1'`, `'1.1'`).
 *
 * @returns Message extracted from the issue and its sub-issues.
 */ function extractMessageFromValiIssue(issue, nesting) {
    const type = `Type: "${issue.type}"`;
    const message = `Message: "${issue.message}"`;
    const path = `Path: "${getDotPath(issue)}"`;
    const messages = [
        `${nesting}. ${type} | ${message} | ${path}`
    ];
    if (issue.issues && issue.issues.length > 0) {
        const nestedMessages = issue.issues.map((subIssue, i)=>extractMessageFromValiIssue(subIssue, `${nesting}.${i + 1}`));
        messages.push(...nestedMessages);
    }
    return messages.join('\n');
}
/**
 * Extracts message from Valibot error.
 *
 * @param error Valibot's {@link ValiError}.
 *
 * @returns Message extracted from the error issues and its sub-issues.
 */ function extractMessageFromValiError(error) {
    if (error.issues.length === 0) {
        return error.message;
    }
    return error.issues.map((issue, i)=>extractMessageFromValiIssue(issue, `${i + 1}`)).join('\n');
}




},

},function(__webpack_require__) {
var __webpack_exec__ = function(moduleId) { return __webpack_require__(__webpack_require__.s = moduleId) }
__webpack_require__.O(0, ["272","733",], function() {
        return __webpack_exec__("./node_modules/.pnpm/@adguard+dnr-converter@2.0.0_@adguard+re2-wasm@1.2.0_typescript@5.6.3/node_modules/@adguard/dnr-converter/dist/index.js");
      });
var __webpack_exports__ = __webpack_require__.O();

}
]);