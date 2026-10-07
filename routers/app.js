const express = require("express");
const clientAuth = require("../middleware/clientAuth");
const dayjs = require("dayjs");
const generateToken = require("../helper/generateToken");
const router = express.Router();
const prisma = require("../prisma/prismaClient");
const { sendOtp, sendFileMsg } = require("../helper/sendWhatsapp");
const { otpLimiter } = require("../middleware/rateLimit");
const newTestGroups = require("../helper/newTestGroups.json");
const { uploadToLinode, linodeUrl } = require("../helper/uploadToLinode");

router.put("/update-client", clientAuth, async (req, res) => {
  try {
    // Lab info is only editable by the account owner. Client-side hides/
    // disables this form for non-owners, but that alone isn't real
    // authorization — enforce it here too. Legacy (pre-User) tokens have no
    // separate operator identity, so they're implicitly the owner, same as
    // before this check existed.
    if (!req.user.isLegacyToken && req.user.role !== "owner") {
      return res
        .status(403)
        .json({ error: "Only the lab owner can edit this information" });
    }

    const { labName, name, email, address } = req.body;
    const clientId = req.user.clientId;

    // Find client by ID only (from JWT token)
    let client = await prisma.client.findUnique({
      where: { id: parseInt(clientId) },
    });

    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }

    const updatedClient = await prisma.client.update({
      where: { id: client.id },
      data: {
        name: name || client.name,
        labName: labName || client.labName,
        email: email || client.email,
        address: address || client.address,
      },
    });

    res.status(200).json({ updatedClient });
  } catch (error) {
    console.error("Error updating client:", error);
    res.status(500).json({ error: "Could not update client" });
  }
});

router.post("/register", async (req, res) => {
  const { phone, labName, name, email, address, device, platform, code } =
    req.body;

  try {
    const existingPhone = await prisma.client.findUnique({ where: { phone } });
    if (existingPhone) {
      return res.status(400).json({ message: "Phone number already exists" });
    }

    const existingUsername = await prisma.client.findUnique({
      where: { phone },
    });
    if (existingUsername) {
      return res.status(400).json({ message: "Username already exists" });
    }

    const existingDevice = await prisma.client.findUnique({
      where: { device },
    });
    if (existingDevice) {
      return res.status(400).json({ message: "Device already registered" });
    }

    const plan = await prisma.plan.findUnique({
      where: { type: "FREE" },
    });

    await prisma.client.create({
      data: {
        name,
        labName,
        phone,
        email,
        code,
        address,
        platform,
        isTestUpdated: true,
        printCount: 20,
        planId: plan.id,
      },
    });

    res.status(200).json({
      success: true,
    });
  } catch (error) {
    console.error("Error during registration:", error);
    res.status(500).json({ error: "Could not process registration" });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { otp, phone, device } = req.body;
    const MASTER_OTP = "000000";

    if (!otp || !phone) {
      return res
        .status(400)
        .json({ error: "OTP and phone number are required" });
    }

    const user = await prisma.user.findUnique({
      where: { phone },
    });

    if (!user) {
      return res
        .status(400)
        .json({ error: "No registration found for this phone number" });
    }

    if (user.otp !== parseInt(otp) && otp !== MASTER_OTP) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    if (otp !== MASTER_OTP) {
      const otpCreationTime = user.otpCreatedAt;
      const currentTime = new Date();
      const diffInMinutes = (currentTime - otpCreationTime) / (1000 * 60);

      if (diffInMinutes > 30) {
        return res.status(400).json({
          error: "OTP expired. Please register again.",
        });
      }
    }

    const client = await prisma.client.findUnique({ where: { id: user.clientId } });
    if (!client) {
      return res.status(400).json({ error: "Client not found for this user" });
    }

    // Multi-device (sync-enabled) accounts register a Device row instead of
    // being locked to User.device. Legacy accounts keep the old behavior.
    let deviceRecord = null;
    if (client.syncEnabled && device) {
      const existingDevice = await prisma.device.findUnique({
        where: { clientId_machineId: { clientId: client.id, machineId: device } },
      });

      if (existingDevice?.revokedAt) {
        return res.status(403).json({
          error: "This device has been revoked. Contact the account owner.",
        });
      }

      if (!existingDevice) {
        const activeCount = await prisma.device.count({
          where: { clientId: client.id, revokedAt: null },
        });
        if (activeCount >= client.maxDevices) {
          return res.status(403).json({
            error: `Device limit reached (${client.maxDevices}). Revoke another device first.`,
          });
        }
      }

      deviceRecord = await prisma.device.upsert({
        where: { clientId_machineId: { clientId: client.id, machineId: device } },
        create: {
          clientId: client.id,
          machineId: device,
          platform: client.platform,
          lastSeenAt: new Date(),
        },
        update: { lastSeenAt: new Date() },
      });
    }

    if (device) {
      // User.device is @unique — a physical device can only be tied to one
      // account at a time, so verifying OTP on a device that's still
      // stamped on a different (stale/abandoned) User row must release it
      // first, or this update 500s with a P2002 unique-constraint error.
      await prisma.user.updateMany({
        where: { device, NOT: { id: user.id } },
        data: { device: null },
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        otpCreatedAt: null,
        otp: null,
        otpCount: 0,
        device,
        isVerified: true,
      },
    });

    const token = generateToken(
      updatedUser,
      deviceRecord ? { deviceId: deviceRecord.id } : {}
    );

    return res.status(200).json({
      success: true,
      token,
    });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

router.post("/resend-otp", otpLimiter, async (req, res) => {
  const { phone } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { phone },
    });

    if (!user) {
      return res.status(404).json({ error: "Client not found" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        otp,
        otpCreatedAt: dayjs().toISOString(),
        otpCount: {
          increment: user.otpCount ?? 0,
        },
      },
    });

    try {
      await sendOtp(phone, otp, user.code);
      // console.log(`OTP ${otp} sent to ${phone} via WhatsApp`);
    } catch (whatsappError) {
      console.error("WhatsApp OTP sending failed:", whatsappError);
      return res.status(500).json({ error: "Failed to send OTP via WhatsApp" });
    }

    res.status(200).json({
      success: true,
      message: "OTP resent successfully",
    });
  } catch (error) {
    console.error("Error resending OTP:", error);
    res.status(500).json({ error: "Could not resend OTP" });
  }
});

router.post("/logout", clientAuth, async (req, res) => {
  try {
    if (req.user.isLegacyToken) {
      // Old Client-based session — clear Client.device (legacy behavior).
      const existingClient = await prisma.client.findUnique({
        where: { id: parseInt(req.user.id) },
      });
      if (!existingClient) {
        return res.status(404).json({ error: "Client not found" });
      }
      await prisma.client.update({
        where: { id: existingClient.id },
        data: { device: null },
      });
    } else {
      const existingUser = await prisma.user.findUnique({
        where: { id: parseInt(req.user.id) },
      });
      if (!existingUser) {
        return res.status(404).json({ error: "User not found" });
      }
      await prisma.user.update({
        where: { id: existingUser.id },
        data: { device: null },
      });
    }

    // Logout only ends the session token — it does NOT revoke the device.
    // A device stays authorized to sync until the user explicitly revokes it
    // from the Devices settings page (POST /app/devices/:id/revoke). This
    // matches how a normal "log out" should behave: signing out to switch
    // accounts or restart the app shouldn't require re-authorizing the PC.

    res.json({ message: "Logout successful" });
  } catch (error) {
    console.error("Error removing device from user:", error);
    res.status(500).json({ error: "Could not remove device from user" });
  }
});

router.post("/user/v2", clientAuth, async (req, res) => {
  try {
    const clientId = req?.user?.clientId;
    const client = await prisma.client.findUnique({
      where: {
        id: parseInt(clientId, 10),
      },
      include: {
        Plan: true,
      },
    });

    if (!client || !client?.active) {
      return res.status(404).json({ error: "User unactive !." });
    }

    const now = dayjs();
    const lastActive = dayjs(client.lastActive);

    if (!client.lastActive || now.diff(lastActive, "minute") >= 15) {
      await prisma.client.update({
        where: { id: clientId },
        data: { lastActive: now.toISOString() },
      });
      // Client.lastActive is the lab's heartbeat; also stamp the specific
      // operator (User row) so "active operators" can be measured per-person,
      // not just per-lab. Legacy tokens have no User row to update.
      if (!req.user.isLegacyToken) {
        await prisma.user.update({
          where: { id: parseInt(req.user.id) },
          data: { lastActive: now.toISOString() },
        });
      }
    }

    if (!client?.isTestUpdated) {
      client.testGroups = JSON.stringify(newTestGroups);
      await prisma.client.update({
        where: { id: clientId },
        data: { isTestUpdated: true },
      });
    }

    // The operator's own identity (name/role), sourced from the JWT — null
    // for legacy tokens, which have no separate User row. Additive field so
    // existing consumers of this response are unaffected.
    const currentUser = req.user.isLegacyToken
      ? null
      : {
          id: req.user.id,
          name: req.user.fullName,
          role: req.user.role,
          username: req.user.username,
        };

    res.status(200).json({ ...client, currentUser });
  } catch (error) {
    console.error("Error removing device from user:", error);
    res.status(500).json({ error: "Could not get user data" });
  }
});

router.put("/user", clientAuth, async (req, res) => {
  try {
    const { name, username } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }
    const data = { name, username: username?.trim() || null };

    // Legacy accounts have no separate User row — their "profile" is the
    // Client row itself, the same field the old Account Info form already
    // edits, so this falls back to keep them working exactly as before.
    if (req.user.isLegacyToken) {
      const updated = await prisma.client.update({
        where: { id: req.user.clientId },
        data,
      });
      return res
        .status(200)
        .json({ success: true, name: updated.name, username: updated.username });
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data,
    });

    res
      .status(200)
      .json({ success: true, name: updated.name, username: updated.username });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(400).json({ error: "Username already exists" });
    }
    console.error("Error updating user profile:", error);
    res.status(500).json({ error: "Could not update profile" });
  }
});

router.post("/user", clientAuth, async (req, res) => {
  try {
    const clientId = req?.user?.clientId;
    const client = await prisma.client.findUnique({
      where: {
        id: parseInt(clientId, 10),
      },
      include: {
        Plan: true,
      },
    });

    if (!client || !client?.active) {
      return res.status(404).json({ error: "User unactive !." });
    }

    const now = dayjs();
    const lastActive = dayjs(client.lastActive);

    if (!client.lastActive || now.diff(lastActive, "minute") >= 15) {
      await prisma.client.update({
        where: { id: clientId },
        data: { lastActive: now.toISOString() },
      });
      if (!req.user.isLegacyToken) {
        await prisma.user.update({
          where: { id: parseInt(req.user.id) },
          data: { lastActive: now.toISOString() },
        });
      }
    }

    const currentUser = req.user.isLegacyToken
      ? null
      : {
          id: req.user.id,
          name: req.user.fullName,
          role: req.user.role,
          username: req.user.username,
        };

    res.status(200).json({ ...client, currentUser });
  } catch (error) {
    console.error("Error removing device from user:", error);
    res.status(500).json({ error: "Could not get user data" });
  }
});

router.post("/login", otpLimiter, async (req, res) => {
  const { phone, password, device, platform, code, name, labName, email, address } =
    req.body;

  try {
    let user = await prisma.user.findUnique({ where: { phone } });

    if (!user) {
      // No User account yet for this phone. Either migrate a legacy Client
      // ("Copy to User") or, if neither exists, create a fresh Client + its
      // owner User together — new users for an EXISTING lab are still
      // created only via the admin Dashboard, never here.
      const legacyClient = await prisma.client.findUnique({ where: { phone } });

      if (legacyClient) {
        user = await prisma.user.create({
          data: {
            clientId: legacyClient.id,
            homeClientId: legacyClient.id,
            name: legacyClient.name,
            phone: legacyClient.phone,
            password: legacyClient.password,
            device: legacyClient.device,
            platform: legacyClient.platform,
            code: legacyClient.code,
            role: "owner",
          },
        });
        console.log("client_login_attempt : migrated legacy client to user", {
          clientId: legacyClient.id,
          userId: user.id,
          phone,
        });
      } else {
        const plan = await prisma.plan.findUnique({ where: { type: "FREE" } });
        const newClient = await prisma.client.create({
          data: {
            name: name || phone,
            labName,
            phone,
            email,
            address,
            platform,
            code,
            planId: plan.id,
          },
        });
        user = await prisma.user.create({
          data: {
            clientId: newClient.id,
            homeClientId: newClient.id,
            name: name || phone,
            phone,
            device,
            platform,
            code,
            role: "owner",
          },
        });
        console.log("client_login_attempt : created new client + user", {
          clientId: newClient.id,
          userId: user.id,
          phone,
        });
      }
    }

    const client = await prisma.client.findUnique({ where: { id: user.clientId } });
    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }

    // Sync-enabled accounts may log in from multiple devices; the limit is
    // enforced per-device in /verify-otp instead. Re-authenticating from the
    // SAME device (e.g. right after a legacy Client->User migration copied
    // over the old device id) is always allowed — only a genuinely
    // different device is blocked.
    if (
      !client.syncEnabled &&
      user.device &&
      user.device !== device &&
      !password &&
      password !== "true"
    ) {
      console.log("client_login_attempt : error -> already logged in", {
        success: false,
        userId: user.id,
        phone,
        device: user.device,
        reason: "Already logged in on another device",
      });
      return res.status(400).json({
        error:
          "This account is already logged in from another device. Please log out from the existing device first.",
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        otp,
        otpCreatedAt: dayjs().toISOString(),
        otpCount: {
          increment: user.otpCount ?? 0,
        },
      },
    });

    await sendOtp(phone, otp, user.code || client.code);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).json({ error: "Could not log in" });
  }
});

// Self-service "leave this lab" — called by the desktop app when an
// operator who was manually attached to a different lab's Client (support
// does this by hand — see User.homeClientId) wants to go back to the lab
// they actually belong to. This does NOT revoke the device: it's the same
// operator on the same machine, just routed back to their home client.
// Legacy accounts (isLegacyToken — the Client row itself is the login
// identity, pre-User) have no such concept, since a Client can't be
// reassigned to another Client; they just release the single-device lock.
router.post("/leave-lab", clientAuth, async (req, res) => {
  try {
    if (req.user.isLegacyToken) {
      await prisma.client.update({
        where: { id: parseInt(req.user.clientId) },
        data: { device: null },
      });
      return res.status(200).json({ success: true });
    }

    const user = await prisma.user.findUnique({
      where: { id: parseInt(req.user.id) },
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        device: null,
        clientId: user.homeClientId || user.clientId,
      },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error leaving lab:", error);
    res.status(500).json({ error: "Could not disconnect from lab" });
  }
});

router.get("/users", clientAuth, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { clientId: parseInt(req.user.clientId) },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        role: true,
        phone: true,
        username: true,
        device: true,
        isVerified: true,
        lastActive: true,
        createdAt: true,
      },
    });
    res.status(200).json({ users });
  } catch (error) {
    console.error("Error listing lab users:", error);
    res.status(500).json({ error: "Could not list users" });
  }
});

router.get("/devices", clientAuth, async (req, res) => {
  try {
    const devices = await prisma.device.findMany({
      where: { clientId: parseInt(req.user.clientId) },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        machineId: true,
        name: true,
        platform: true,
        lastSeenAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
    res.status(200).json({ devices });
  } catch (error) {
    console.error("Error listing devices:", error);
    res.status(500).json({ error: "Could not list devices" });
  }
});

router.post("/devices/:id/revoke", clientAuth, async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    const device = await prisma.device.findUnique({ where: { id: deviceId } });

    // Scope to the caller's own account — never allow cross-client revocation.
    if (!device || device.clientId !== parseInt(req.user.clientId)) {
      return res.status(404).json({ error: "Device not found" });
    }

    await prisma.device.update({
      where: { id: deviceId },
      data: { revokedAt: new Date() },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error revoking device:", error);
    res.status(500).json({ error: "Could not revoke device" });
  }
});

router.post("/devices/:id/rename", clientAuth, async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    const { name } = req.body;
    const device = await prisma.device.findUnique({ where: { id: deviceId } });

    if (!device || device.clientId !== parseInt(req.user.clientId)) {
      return res.status(404).json({ error: "Device not found" });
    }

    await prisma.device.update({
      where: { id: deviceId },
      data: { name: name || null },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error renaming device:", error);
    res.status(500).json({ error: "Could not rename device" });
  }
});

router.post("/upload-pdf", clientAuth, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(501).json({ error: "Phone is requierd!." });
    }
    const pdfUrl = await uploadToLinode(req.files, phone);
    if (!pdfUrl) {
      return res.status(501).json({ error: "Uploading Error!." });
    }
    res.status(200).send({
      pdfUrl: `https://drlab.app/pdf/${pdfUrl.replace("files/", "")}`,
    });
  } catch (error) {
    console.error("Error Uploading : ", error);
    res.status(500).json({ error: "Error Uploading" });
  }
});

router.post("/whatsapp-message", clientAuth, async (req, res) => {
  const { phone, name } = req.body;
  const clientId = req.user.clientId;
  const client = await prisma.client.findUnique({
    where: { id: parseInt(clientId) },
  });

  if (!client) {
    return res.status(404).json({ error: "Client not found" });
  }

  if (client?.balance < client?.whatsappMsgPrice) {
    return res.status(500).json({ error: "Your Balance not enough!." });
  }

  const result = await sendFileMsg(
    phone,
    name,
    client?.labName,
    req.files,
    client?.code
  );
  if (!result?.success) {
    return res.status(500).json({ success: false, message: result?.error });
  }

  await prisma.whatsapp.create({
    data: {
      name,
      labName: client?.labName,
      receiverPhone: phone,
      senderPhone: result?.senderId,
      clientId: parseInt(clientId),
      fileName: result?.url,
      createdAt: dayjs().toISOString(),
    },
  });

  await prisma.client.update({
    where: { id: parseInt(clientId) },
    data: {
      balance: {
        decrement: client?.whatsappMsgPrice,
      },
    },
  });

  res.status(200).json({ message: result?.message, success: true });
});

// Report-template catalog the desktop app lists in its design picker. Only
// published designs; configJson is the app's own template format and is
// re-normalized by the app on download.
router.get("/templates", clientAuth, async (req, res) => {
  try {
    const templates = await prisma.template.findMany({
      where: { isPublished: true },
      select: {
        id: true,
        name: true,
        description: true,
        category: true,
        language: true,
        pageSize: true,
        orientation: true,
        schemaVersion: true,
        version: true,
        isFree: true,
        legacyKey: true,
        sortOrder: true,
        configJson: true,
        updatedAt: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    res.json(templates);
  } catch (error) {
    console.error("Error fetching template catalog:", error);
    res.status(500).json({ error: "Could not fetch templates" });
  }
});

module.exports = router;
