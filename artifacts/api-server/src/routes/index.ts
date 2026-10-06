import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mp4Router from "./mp4-poc";
const router: IRouter = Router();
router.use(healthRouter);
router.use(mp4Router);
export default router;
