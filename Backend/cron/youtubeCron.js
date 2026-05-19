import cron from "node-cron";
import prisma from "../prisma/client.js";
import { getYouTubeVideoDetails } from "../utils/youtube.js";

/* ====================================== */
/* PREVENT OVERLAPPING CRON */
/* ====================================== */

let running = false;

/* ====================================== */
/* RUN EVERY 1 MINUTE */
/* ====================================== */

cron.schedule("*/1 * * * *", async () => {

  if (running) {
    console.log("⏳ Previous cron still running...");
    return;
  }

  running = true;

  console.log("🚀 Running YouTube Cron...");

  try {

    const submissions = await prisma.submission.findMany({
      where: {
        status: "APPROVED",
        isVerified: true,
        isEligible: true,
        videoId: {
          not: null,
        },
      },
      include: {
        campaign: true,
        socialAccount: true,
      },
    });

    for (const sub of submissions) {

      try {

        /* ====================================== */
        /* ONLY YOUTUBE */
        /* ====================================== */

        if (sub.socialAccount.platform !== "YOUTUBE") {
          continue;
        }

        /* ====================================== */
        /* FETCH VIDEO STATS */
        /* ====================================== */

        const stats = await getYouTubeVideoDetails(sub.videoId);

        if (!stats) {
          console.log("❌ No stats for:", sub.videoId);
          continue;
        }

        const {
          views,
          likes,
          comments,
          shares,
        } = stats;

        const previousViews = sub.views || 0;

        /* ====================================== */
        /* BASIC SAFETY CHECKS */
        /* ====================================== */

        // ❌ prevent decreasing views
        if (views < previousViews) {
          continue;
        }

        // ❌ no new views
        if (views === previousViews) {
          continue;
        }

        const engagementRate =
          views > 0
            ? ((likes + comments + shares) / views) * 100
            : 0;

        // ❌ anti-bot protection
        if (engagementRate < 0.1) {
          continue;
        }

        const growth = views - previousViews;

        // ❌ unrealistic spike
        if (growth > 5_000_000) {
          console.log("⚠️ Suspicious spike:", growth);
          continue;
        }

        /* ====================================== */
        /* CALCULATE NEW EARNINGS */
        /* ====================================== */

        const newViews = growth;

        let payable =
          (newViews / 1_000_000) *
          sub.campaign.ratePerMillion;

        payable = Number(payable.toFixed(2));

        // ❌ no earnings
        if (payable <= 0) {
          continue;
        }

        /* ====================================== */
        /* MAX EARNINGS PER POST */
        /* ====================================== */

        if (sub.campaign.maxEarningsPerPost > 0) {

          const remainingPostLimit =
            sub.campaign.maxEarningsPerPost -
            (sub.earnings || 0);

          if (remainingPostLimit <= 0) {
            continue;
          }

          payable = Math.min(
            payable,
            remainingPostLimit
          );
        }

        /* ====================================== */
        /* CAMPAIGN BUDGET CHECK */
        /* ====================================== */

        payable = Math.min(
          payable,
          sub.campaign.remainingBudget
        );

        if (payable <= 0) {
          continue;
        }

        /* ====================================== */
        /* USER MAX EARNINGS */
        /* ====================================== */

        const userTotal =
          await prisma.submission.aggregate({
            where: {
              userId: sub.userId,
              campaignId: sub.campaignId,
            },
            _sum: {
              earnings: true,
            },
          });

        const totalEarned =
          userTotal._sum.earnings || 0;

        if (sub.campaign.maxEarnings > 0) {

          const remainingUserLimit =
            sub.campaign.maxEarnings -
            totalEarned;

          if (remainingUserLimit <= 0) {
            continue;
          }

          payable = Math.min(
            payable,
            remainingUserLimit
          );
        }

        // ❌ final protection
        if (payable <= 0) {
          continue;
        }

        console.log({
          video: sub.videoId,
          previousViews,
          currentViews: views,
          growth,
          payable,
        });

        /* ====================================== */
        /* SAFE SUBMISSION UPDATE */
        /* ====================================== */

        // 🔥 prevents duplicate payout
        // 🔥 prevents race condition

        const updatedSubmission =
          await prisma.submission.updateMany({
            where: {
              id: sub.id,
              views: previousViews,
            },
            data: {
              views,
              likes,
              comments,
              shares,
              engagementRate,
              earnings: {
                increment: payable,
              },
            },
          });

        // another cron already updated
        if (updatedSubmission.count === 0) {
          console.log(
            "⚠️ Submission already updated:",
            sub.id
          );

          continue;
        }

        /* ====================================== */
        /* SAFE BALANCE + BUDGET UPDATE */
        /* ====================================== */

        await prisma.$transaction([

          prisma.user.update({
            where: {
              id: sub.userId,
            },
            data: {
              balance: {
                increment: payable,
              },
            },
          }),

          prisma.campaign.update({
            where: {
              id: sub.campaignId,
            },
            data: {
              remainingBudget: {
                decrement: payable,
              },
            },
          }),

        ]);

        /* ====================================== */
        /* AUTO COMPLETE CAMPAIGN */
        /* ====================================== */

        const updatedCampaign =
          await prisma.campaign.findUnique({
            where: {
              id: sub.campaignId,
            },
          });

        if (
          updatedCampaign &&
          updatedCampaign.remainingBudget <= 0
        ) {

          await prisma.campaign.update({
            where: {
              id: sub.campaignId,
            },
            data: {
              status: "COMPLETED",
            },
          });

        }

      } catch (err) {

        console.error(
          `❌ Error processing submission ${sub.id}:`,
          err
        );

        continue;
      }
    }

    console.log("✅ YouTube Cron Done");

  } catch (err) {

    console.error("❌ CRON ERROR:", err);

  } finally {

    running = false;
  }

});