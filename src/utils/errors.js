/**
 * 统一错误类：业务逻辑中抛出，由 errorHandler 中间件统一处理
 */
class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AppError';
  }
}

/**
 * 统一错误响应中间件（注册在所有路由之后）
 */
function errorHandler(err, req, res, _next) {
  // multer 文件上传错误
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '文件大小超出限制' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(400).json({ error: '请求体过大' });
  }

  const status = err.statusCode || 500;
  if (status === 500) console.error('Internal error:', err);
  res.status(status).json({ error: err.message });
}

module.exports = { AppError, errorHandler };
