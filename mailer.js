const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const nodemailer = require('nodemailer');

const secretsClient = new SecretManagerServiceClient();

async function getSecret(name) {
    const [version] = await secretsClient.accessSecretVersion({
        name: `projects/asistente-whatsapp-ia/secrets/${name}/versions/latest`
    });
    return version.payload.data.toString();
}

async function enviarAlerta(asunto, cuerpo) {
    try {
        const user = await getSecret('email-user');
        const pass = await getSecret('email-pass');
        const reciber = await getSecret('email-reciber');

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user, pass }
        });

        await transporter.sendMail({
            from: `"Bot WhatsApp" <${user}>`,
            to: reciber, // o un correo destino fijo
            subject: asunto,
            text: cuerpo
        });

        console.log('📧 Alerta enviada por correo.');
    } catch (error) {
        console.error('❌ Error al enviar alerta:', error);
    }
}

module.exports = { enviarAlerta };
