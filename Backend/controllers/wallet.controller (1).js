import prisma from "../prisma/client.js";


export const getBalance = async (req, res) => {
  try {
    const userId = req.user.userId;

  const user = await prisma.user.findUnique({
  where: { id: userId },
  include: {
    paymentMethods: true
  }
});

    res.json({
  balance: Math.max(0, user.balance)
});
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch balance" });
  }
};
export const requestWithdrawal = async (req, res) => {
  try {
    console.log("WITHDRAW API HIT");

    const userId = req.user.userId;
    const { amount } = req.body;

    const parsedAmount = Number(amount);

    /* ============================= */
    /* VALIDATION */
    /* ============================= */

    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({
        message: "Invalid amount",
      });
    }

    /* ============================= */
    /* TRANSACTION (SAFE) */
    /* ============================= */

    const result = await prisma.$transaction(async (tx) => {

      /* ============================= */
      /* FETCH USER */
      /* ============================= */

      const user = await tx.user.findUnique({
        where: { id: userId },
        include: {
          paymentMethods: {
            where: { isDefault: true },
            take: 1,
          },
        },
      });

      if (!user) {
        throw new Error("User not found");
      }

      const paymentMethod = user.paymentMethods[0];

      /* ============================= */
      /* VALIDATIONS */
      /* ============================= */

      // ❌ no payment method
      if (!paymentMethod) {
        throw new Error("Add payment method first");
      }

      // ❌ minimum withdrawal
      if (parsedAmount < 50) {
        throw new Error("Minimum withdrawal is ₹50");
      }

      // ❌ already pending
      const existing = await tx.withdrawal.findFirst({
        where: {
          userId,
          status: "PENDING",
        },
      });

      if (existing) {
        throw new Error("You already have a pending withdrawal");
      }

      /* ============================= */
      /* SAFE BALANCE UPDATE */
      /* ============================= */

      // ✅ Prevent race condition
      // ✅ Prevent negative balance
      const updated = await tx.user.updateMany({
        where: {
          id: userId,
          balance: {
            gte: parsedAmount,
          },
        },
        data: {
          balance: {
            decrement: parsedAmount,
          },
        },
      });

      // ❌ insufficient balance
      if (updated.count === 0) {
        throw new Error("Insufficient balance");
      }

      /* ============================= */
      /* CREATE WITHDRAWAL */
      /* ============================= */

      const withdrawal = await tx.withdrawal.create({
        data: {
          userId,
          amount: parsedAmount,
          upiId: paymentMethod.upiId,
          status: "PENDING",
        },
      });

      return withdrawal;
    });

    /* ============================= */
    /* SUCCESS RESPONSE */
    /* ============================= */

    res.json({
      message: "Withdrawal request submitted",
      withdrawal: result,
    });

  } catch (error) {
    console.error("WITHDRAW ERROR:", error);

    res.status(400).json({
      message: error.message || "Withdrawal failed",
    });
  }
};